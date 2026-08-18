/* eslint-disable @n8n/community-nodes/require-node-api-error */
/**
 * HTTP span collector — TypeScript port of otel_setup.py + http_governance_hooks.py +
 * the relevant parts of WorkflowSpanProcessor, scoped to n8n.
 *
 * The Python SDK intercepts HTTP calls via OTel httpx instrumentation and patches
 * httpx.Client.send. In Node.js 18+ (n8n's runtime), openai-node uses the native
 * fetch API (undici). We patch the global fetch the same way Python patches
 * httpx.Client.send — capturing request/response bodies and posting
 * ActivityStarted + hook_trigger + http_request spans to Core.
 *
 * Flow (mirrors Python SDK):
 *   1. wrapModelCall calls registerActivity(activityId, activityContext, ...)
 *      → mirrors span_processor.set_activity_context()
 *   2. Patched fetch fires on the actual LLM HTTP call
 *      → mirrors _httpx_request_hook / _patched_send
 *   3. ActivityStarted + http_request spans are POSTed to Core
 *      → mirrors hook_governance.evaluate_async()
 *   4. wrapModelCall calls unregisterActivity(activityId)
 *      → mirrors span_processor.clear_activity_context()
 */

import { IExecuteFunctions } from 'n8n-workflow';

// Load AsyncLocalStorage via a variable to avoid the static 'async_hooks'
// import restriction in n8n community-node ESLint rules.
const _ahMod = 'async_hooks';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AsyncLocalStorage } = require(_ahMod) as typeof import('async_hooks');

const _timersMod = 'timers';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setTimeout: _st } = require(_timersMod) as typeof import('timers');

import { openboxRequest, GovernanceAuthError, SoftGovernanceError } from '../openbox-client';
import { safeString } from './error-info';
import { GovernanceClient, OnApiError } from './client';
import type { HITLConfig, Logger } from './config';
import { rfc3339Now, hexId, GovernanceVerdictResponse } from './types';
import { GovernanceBlockedError, GovernanceHaltError, formatActivityRejectedMessage, verdictFromString } from './verdict';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => _st(resolve, ms));
}

// ── Activity context registry (mirrors WorkflowSpanProcessor._activity_context) ──

interface ActivityContext {
  source: 'workflow-telemetry';
  workflow_id: string;
  run_id: string;
  workflow_type: string;
  task_queue: string | undefined;
  session_id: string | undefined;
  event_type: 'ActivityStarted';
  activity_id: string;
  activity_type: string;
}

export interface RegisterActivityOptions {
  hitl: HITLConfig;
  onApiError: OnApiError;
  logger: Logger;
  /** GovernanceConfig.governanceTimeout converted to ms. */
  requestTimeoutMs: number;
}

interface ActiveEntry {
  ctx: ActivityContext;
  executeFunctions: IExecuteFunctions;
  traceId: string;
  hitl: HITLConfig;
  onApiError: OnApiError;
  logger: Logger;
  requestTimeoutMs: number;
}

// Global registry keyed by activityId — only one entry active at a time per LLM call
const _activeActivities = new Map<string, ActiveEntry>();
const _activityAbort = new Map<string, string>();
// Activities approved at ToolStarted/LLMStarted level — hook-level require_approval
// verdicts are suppressed for these so one approval covers the full tool execution.
const _approvedActivities = new Set<string>();
const _activityScope = new AsyncLocalStorage<string>();
const _recentSpans = new Map<string, number>();
const _recentSpanTtlMs = 1000;

let _patched = false;
let _httpModulesPatched = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _originalFetch: ((...args: any[]) => Promise<any>) | null = null;

// ── Ignored URL prefixes (Core API itself, to avoid infinite loops) ────────────

const _ignoredPrefixes: string[] = [
  'https://core.openbox.ai',
  'http://core.openbox.ai',
];

/**
 * Register an extra URL prefix to ignore (e.g. a self-hosted OpenBox URL).
 * Called once at middleware construction time.
 */
export function addIgnoredPrefix(prefix: string): void {
  const normalised = prefix.replace(/\/+$/, '');
  if (!_ignoredPrefixes.includes(normalised)) {
    _ignoredPrefixes.push(normalised);
  }
}

export function shouldIgnore(url: string): boolean {
  return _ignoredPrefixes.some((p) => url.startsWith(p));
}

// ── LLM provider detection (gen_ai.system per OTel semantic conventions) ────

const LLM_PROVIDERS: Array<{ host: string; system: string }> = [
  { host: 'api.openai.com',                      system: 'openai' },
  { host: 'api.anthropic.com',                   system: 'anthropic' },
  { host: 'generativelanguage.googleapis.com',   system: 'google' },
  { host: 'openrouter.ai',                       system: 'openrouter' },
  { host: 'api.mistral.ai',                      system: 'mistral' },
  { host: 'api.groq.com',                        system: 'groq' },
  { host: 'api.together.xyz',                    system: 'together' },
  { host: 'api.together.ai',                     system: 'together' },
  { host: 'api.cohere.com',                      system: 'cohere' },
];

function detectGenAiSystem(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    // Azure OpenAI: <resource>.openai.azure.com
    if (hostname.endsWith('.openai.azure.com')) return 'azure_openai';
    // AWS Bedrock: bedrock-runtime.<region>.amazonaws.com
    if (hostname.includes('bedrock') && hostname.endsWith('.amazonaws.com')) return 'aws_bedrock';
    const match = LLM_PROVIDERS.find((p) => hostname === p.host || hostname.endsWith(`.${p.host}`));
    return match?.system ?? null;
  } catch {
    return null;
  }
}

// ── Span builder (mirrors _build_http_span_data in http_governance_hooks.py) ───

export function buildHttpSpanData(opts: {
  activityId: string;
  method: string;
  url: string;
  stage: 'started' | 'completed';
  requestBody: string | null;
  responseBody: string | null;
  statusCode: number | null;
  startMs: number;
  endMs?: number;
}): Record<string, unknown> {
  const startNs = opts.startMs * 1_000_000;
  const endNs = opts.endMs != null ? opts.endMs * 1_000_000 : null;
  const durationNs = endNs != null ? endNs - startNs : null;
  const error =
    opts.statusCode != null && opts.statusCode >= 400 ? `HTTP ${opts.statusCode}` : null;

  // Name: include status code on completed spans so the dashboard shows
  // e.g. "POST https://api.openai.com/v1/chat/completions 200"
  const name = opts.stage === 'completed' && opts.statusCode != null
    ? `${opts.method} ${opts.url} ${opts.statusCode}`
    : `${opts.method} ${opts.url}`;

  // start_time: for "completed" spans use end timestamp (mirrors Python SDK §5.6)
  const spanStartNs = opts.stage === 'completed' ? (endNs ?? startNs) : startNs;
  const genAiSystem = detectGenAiSystem(opts.url);

  return {
    span_id: hexId(16),
    trace_id: hexId(32),
    parent_span_id: null,
    name,
    kind: 'CLIENT',
    stage: opts.stage,
    start_time: spanStartNs,
    end_time: endNs,
    duration_ns: durationNs,
    attributes: {
      'http.method': opts.method,
      'http.url': opts.url,
      ...(genAiSystem != null ? { 'gen_ai.system': genAiSystem } : {}),
    },
    status: { code: error ? 'ERROR' : 'UNSET', description: error },
    events: [],
    hook_type: 'http_request',
    http_method: opts.method,
    http_url: opts.url,
    gen_ai_system: genAiSystem,
    request_body: opts.requestBody,
    request_headers: null,
    response_body: opts.responseBody,
    response_headers: null,
    http_status_code: opts.statusCode,
    error,
    // Injected by Python's _build_payload for server-side correlation
    activity_id: opts.activityId,
  };
}

// ── Evaluate helper (fire-and-forget — mirrors hook_governance.evaluate_async) ──

async function evaluateHookSpan(
  entry: ActiveEntry,
  spanData: Record<string, unknown>,
): Promise<void> {
  if (isDuplicateSpan(entry.ctx.activity_id, spanData)) return;
  const payload: Record<string, unknown> = {
    ...entry.ctx,
    timestamp: rfc3339Now(),
    spans: [spanData],
    span_count: 1,
    hook_trigger: true,
  };
  try {
    const response = await openboxRequest<GovernanceVerdictResponse>(entry.executeFunctions, {
      method: 'POST',
      path: '/api/v1/governance/evaluate',
      body: payload,
      traceId: entry.traceId,
      timeoutMs: entry.requestTimeoutMs,
    });
    // Span is always sent to Core so it shows on the dashboard.
    // For already-approved activities, skip verdict enforcement — enforcing would
    // create spurious approval rows. The ToolStarted approval covers the full call.
    if (!_approvedActivities.has(entry.ctx.activity_id)) {
      await enforceHookVerdict(entry, response, String(spanData.http_url ?? spanData.name ?? 'hook'));
    }
  } catch (err) {
    if (err instanceof GovernanceBlockedError || err instanceof GovernanceHaltError) throw err;
    // Auth/signing failures always hard-fail, regardless of onApiError.
    if (err instanceof GovernanceAuthError) throw err;
    // Other soft failures (network/API) respect the configured policy —
    // default fail_open so governance errors don't crash the model call.
    if (err instanceof SoftGovernanceError && entry.onApiError === 'fail_closed') throw err;
    if (!(err instanceof SoftGovernanceError)) {
      entry.logger.warn('span evaluate failed', err);
    }
  }
}

function isDuplicateSpan(activityId: string, spanData: Record<string, unknown>): boolean {
  const hookType = spanData.hook_type;
  if (typeof hookType !== 'string') return false;
  const now = Date.now();
  for (const [key, seenAt] of _recentSpans) {
    if (now - seenAt > _recentSpanTtlMs) {
      _recentSpans.delete(key);
    }
  }
  // Generalized across all hook types (http_request, db_query, file_operation) —
  // previously only http spans were deduplicated, so file/db spans had no
  // duplicate-suppression at all.
  const identity =
    hookType === 'http_request'
      ? [spanData.http_method, spanData.http_url, spanData.http_status_code ?? '']
      : hookType === 'db_query'
        ? [spanData.db_system, spanData.db_statement, spanData.rowcount ?? '']
        : [spanData.file_path, spanData.file_operation];
  const key = [activityId, spanData.stage, hookType, ...identity].join('|');
  const seenAt = _recentSpans.get(key);
  if (seenAt != null && now - seenAt <= _recentSpanTtlMs) {
    return true;
  }
  _recentSpans.set(key, now);
  return false;
}

export async function evaluateActivitySpan(
  activityId: string,
  spanData: Record<string, unknown>,
): Promise<void> {
  // _activityAbort is only ever set for a terminal block/halt verdict now (see
  // enforceHookVerdict below) — require_approval is resolved by polling inline
  // before it ever reaches this map.
  const abortReason = _activityAbort.get(activityId);
  if (abortReason) {
    throw new GovernanceBlockedError('halt', abortReason);
  }
  const entry = _activeActivities.get(activityId);
  if (!entry) return;
  await evaluateHookSpan(entry, spanData);
}

export function getCurrentActivityId(): string | undefined {
  return _activityScope.getStore();
}

/**
 * Poll Core for approval on a hook-level (span) verdict, blocking until
 * allowed/rejected/expired. Mirrors pollApprovalOrHalt() but operates on an
 * ActiveEntry (available inside the fetch/DB patch) instead of the full
 * OpenBoxLangChainMiddleware instance.
 *
 * Polling happens INLINE here — before evaluateHookSpan/enforceHookVerdict
 * ever throws — so require_approval never surfaces as an exception out of
 * the patched fetch/query call. This matters because that call runs inside
 * the LLM/DB client's own retry wrapper (e.g. LangChain's AsyncCaller), which
 * has no notion of "this error means poll and retry" — it just sees an
 * unrecognized error and burns through its own retry budget with exponential
 * backoff, or gives up and surfaces a generic failure, before our HITL logic
 * ever got a chance to run.
 */
/**
 * Record the resolved reason in the abort side-channel BEFORE throwing, then
 * return the error to throw. This is the one source of truth for "why was
 * this activity aborted" that survives no matter how an external HTTP/LLM
 * client library mangles or replaces the thrown exception on its way out of
 * a patched fetch/http call — e.g. the OpenAI SDK wraps ANY error its fetch
 * implementation throws as a generic APIConnectionError with the fixed
 * message "Connection error.", discarding the real reason. Callers up the
 * stack should prefer getActivityAbortReason(activityId) over trying to
 * introspect the caught error itself.
 */
function abortAndThrow(activityId: string, message: string): GovernanceHaltError {
  _activityAbort.set(activityId, message);
  return new GovernanceHaltError(message);
}

async function pollHookApproval(
  entry: ActiveEntry,
  activityId: string,
  activityType: string,
  approvalId?: string,
): Promise<void> {
  const { hitl } = entry;
  if (!hitl.enabled) {
    throw abortAndThrow(activityId, `Approval required for activity ${activityType}`);
  }

  const client = new GovernanceClient(entry.executeFunctions, entry.traceId, entry.requestTimeoutMs);
  const startedAt = Date.now();
  while (hitl.timeoutMs == null || Date.now() - startedAt <= hitl.timeoutMs) {
    const response = await client.pollApproval(
      entry.ctx.workflow_id,
      entry.ctx.run_id,
      activityId,
      approvalId,
      entry.onApiError,
    );
    if (response == null) {
      await sleep(hitl.pollIntervalMs);
      continue;
    }

    if (response.expired) {
      throw abortAndThrow(
        activityId,
        `Approval expired for activity ${activityType} (workflow_id=${entry.ctx.workflow_id}, run_id=${entry.ctx.run_id}, activity_id=${activityId})`,
      );
    }

    // No arm/verdict/action field at all means still pending (no human
    // decision recorded yet) — not "allow". See hitl.ts's pollApprovalOrHalt
    // for the full explanation; this is the hook-level (fetch/db span) twin
    // of that same poll loop and had the identical bug.
    const rawVerdict = response.arm ?? response.verdict ?? response.action;
    if (typeof rawVerdict !== 'string' || rawVerdict.trim() === '') {
      await sleep(hitl.pollIntervalMs);
      continue;
    }

    const verdict = verdictFromString(rawVerdict);

    if (verdict === 'allow') return;
    if (verdict === 'block' || verdict === 'halt') {
      throw abortAndThrow(activityId, formatActivityRejectedMessage(response.reason));
    }

    await sleep(hitl.pollIntervalMs);
  }

  throw abortAndThrow(
    activityId,
    `Approval timed out for activity ${activityType} (workflow_id=${entry.ctx.workflow_id}, run_id=${entry.ctx.run_id}, activity_id=${activityId})`,
  );
}

async function enforceHookVerdict(
  entry: ActiveEntry,
  response: GovernanceVerdictResponse | null,
  identifier: string,
): Promise<void> {
  if (response == null) return;
  const activityId = entry.ctx.activity_id;
  const verdict = verdictFromString(response.verdict ?? response.arm ?? response.action);

  if (verdict === 'require_approval') {
    const approvalId = response.approval_id ?? response.approvalId ?? response.id;
    await pollHookApproval(entry, activityId, entry.ctx.activity_type, approvalId as string | undefined);
    // Approved — mark so a subsequent hook span or the ToolCompleted/LLMCompleted
    // event-level check doesn't ask Core for approval a second time.
    markActivityApproved(activityId);
    return;
  }

  if (verdict === 'block' || verdict === 'halt') {
    const reason = response.reason ?? 'Blocked by governance';
    _activityAbort.set(activityId, reason);
    throw new GovernanceBlockedError(verdict, `${reason} (${identifier})`);
  }
}

// ── Fetch patch (mirrors setup_httpx_body_capture in http_governance_hooks.py) ──
// Use `any` throughout — the dom lib is not in tsconfig.json lib, so fetch/Request/
// Response types are not available at compile time. We guard at runtime.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFetch = (...args: any[]) => Promise<any>;

function patchFetch(): void {
  if (_patched) return;
  if (typeof fetch !== 'function') return; // Node < 18: no native fetch
  _patched = true;
  _originalFetch = fetch as AnyFetch;
  const captured = _originalFetch!;

  // @ts-expect-error -- fetch is a writable global in Node.js 18+ (undici); TypeScript's
  // declaration via @types/node as a function type does not reflect its runtime writability.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetch = async function patchedFetch(input: any, init?: any): Promise<any> {
    // Fast-path: no active governed activity — skip all instrumentation.
    if (_activeActivities.size === 0) {
      return captured(input, init);
    }
    // Resolve activityId from the async-local scope only. Previously this
    // fell back to "the first key in the global activity map" when the scope
    // was empty — under concurrent executions in the same process, that could
    // attribute one execution's HTTP span (and any governance verdict tied to
    // it) to a completely different execution's activity. Skipping
    // instrumentation when context is missing (like every other patch here
    // already does) is the safe behavior.
    const activityId = _activityScope.getStore();
    if (!activityId || !_activeActivities.has(activityId)) {
      return captured(input, init);
    }

    const urlStr: string = (() => {
      try {
        if (typeof input === 'string') return input;
        if (input instanceof URL) return input.toString();
        return String(input?.url ?? '');
      } catch { return ''; }
    })();

    if (!urlStr || shouldIgnore(urlStr)) {
      return captured(input, init);
    }

    // Only ever set for a terminal block/halt verdict now — require_approval is
    // resolved by polling inline inside evaluateHookSpan before it gets here.
    const abortReason = _activityAbort.get(activityId);
    if (abortReason) {
      throw new GovernanceBlockedError('halt', abortReason);
    }

    const entry = _activeActivities.get(activityId);
    if (!entry) return captured(input, init);

    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    const startMs = Date.now();

    // Capture request body (mirrors _capture_httpx_request_data)
    let requestBody: string | null = null;
    try {
      const bodyVal = init?.body;
      if (typeof bodyVal === 'string') {
        requestBody = bodyVal;
      } else if (bodyVal instanceof ArrayBuffer || ArrayBuffer.isView(bodyVal)) {
        requestBody = new TextDecoder().decode(bodyVal as ArrayBuffer);
      } else if (bodyVal == null && typeof input?.clone === 'function') {
        requestBody = await input.clone().text().catch(() => null);
      }
    } catch { /* best effort */ }

    // Evaluate "started" span (mirrors _httpx_async_request_hook)
    await evaluateHookSpan(
      entry,
      buildHttpSpanData({ activityId, method, url: urlStr, stage: 'started', requestBody, responseBody: null, statusCode: null, startMs }),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await captured(input, init);
    const endMs = Date.now();

    // Capture response body (mirrors _capture_httpx_response_data / _patched_async_send)
    // Race against a 5-second timeout so a never-terminating response body stream
    // (e.g. a 503 from a load balancer that keeps the connection open) doesn't
    // hang the patched fetch and block the caller indefinitely.
    let responseBody: string | null = null;
    try {
      const contentType = String(response?.headers?.get?.('content-type') ?? '');
      if (contentType.includes('application/json') || contentType.startsWith('text/')) {
      const bodyTimeout = new Promise<null>((resolve) => _st(() => resolve(null), 5_000));
        responseBody = await Promise.race([
          response.clone().text().catch((): null => null),
          bodyTimeout,
        ]);
      }
    } catch { /* best effort */ }

    // Evaluate "completed" span (mirrors _patched_async_send). require_approval
    // is resolved by polling inline inside evaluateHookSpan — it blocks here
    // until approved/rejected rather than throwing, so the response is only
    // ever returned once the verdict is settled. block/halt still throw and
    // discard this response immediately.
    await evaluateHookSpan(
      entry,
      buildHttpSpanData({ activityId, method, url: urlStr, stage: 'completed', requestBody, responseBody, statusCode: response?.status ?? null, startMs, endMs }),
    );

    return response;
  };
}

function patchHttpModules(): void {
  if (_httpModulesPatched) return;
  _httpModulesPatched = true;
  patchHttpModule('node:http');
  patchHttpModule('node:https');
}

function patchHttpModule(moduleName: 'node:http' | 'node:https'): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(moduleName) as Record<string, unknown>;
    if ((mod as { _openboxPatched?: boolean })._openboxPatched) return true;
    const originalRequest = mod.request;
    const originalGet = mod.get;
    if (typeof originalRequest !== 'function') return false;
    (mod as { _openboxPatched?: boolean })._openboxPatched = true;

    const requestWrapper = function patchedRequest(this: unknown, ...args: unknown[]) {
      const activityId = _activityScope.getStore();
      if (!activityId) return Reflect.apply(originalRequest, this, args);
      const entry = _activeActivities.get(activityId);
      if (!entry) return Reflect.apply(originalRequest, this, args);

      const startMs = Date.now();
      const reqBodyChunks: Buffer[] = [];
      const method = extractHttpMethod(args);
      const url = extractHttpUrl(moduleName, args);
      if (!url || shouldIgnore(url)) return Reflect.apply(originalRequest, this, args);

      const callbackIndex = args.findIndex((arg) => typeof arg === 'function');
      const originalCallback = callbackIndex >= 0 ? args[callbackIndex] as (...cbArgs: unknown[]) => void : null;

      if (originalCallback) {
        args[callbackIndex] = (response: {
          statusCode?: number;
          headers?: Record<string, unknown>;
          on?: (event: string, cb: (...cbArgs: unknown[]) => void) => unknown;
          once?: (event: string, cb: (...cbArgs: unknown[]) => void) => unknown;
          off?: (event: string, cb: (...cbArgs: unknown[]) => void) => unknown;
          emit?: (event: string, ...emitArgs: unknown[]) => unknown;
        }) => {
          const responseChunks: Buffer[] = [];
          // Kept separately from responseChunks (which is only ever read as
          // text for the span) so the bytes handed back to the real consumer
          // are exactly the ones that arrived, whatever their encoding.
          const replayChunks: unknown[] = [];

          const onData = (chunk: unknown) => {
            captureHttpBodyChunk(responseChunks, chunk);
            replayChunks.push(chunk);
          };

          // Attaching a 'data' listener puts the response into flowing mode,
          // so by the time the governance verdict settles below the stream is
          // already drained AND ended. Handing that exhausted object straight
          // to the caller means its own 'data'/'end' listeners — attached one
          // tick too late — never fire, and the request hangs until the
          // caller's timeout (n8n's HTTP nodes sit on axios, which is exactly
          // this shape: "Response body timed out ... without data"). So detach
          // our listener and replay the buffered body once the caller has had
          // a chance to subscribe. Object identity is preserved deliberately —
          // substituting a PassThrough would drop IncomingMessage fields that
          // consumers read off the response.
          const replayTo = (target: typeof response) => {
            target.off?.('data', onData);
            originalCallback(target);
            // setImmediate, not sync: the caller subscribes inside the
            // callback above, and must be listening before anything is emitted.
            setImmediate(() => {
              for (const chunk of replayChunks) target.emit?.('data', chunk);
              target.emit?.('end');
            });
          };

          response.on?.('data', onData);
          // `once` — the replayed 'end' below must not re-enter this handler.
          response.once?.('end', () => {
            const endMs = Date.now();
            const requestBody = chunksToText(reqBodyChunks);
            const responseBody = chunksToText(responseChunks);
            // Governance is the gate for handing the response to the caller — mirrors
            // patchFetch's "completed" check, where the response is only ever returned
            // once the verdict is settled. This used to be `void evaluateHookSpan(...)`
            // while `originalCallback(response)` ran unconditionally right after, so a
            // require_approval verdict resolved against a response the caller had
            // already consumed — a human decision made later had nothing left to affect.
            evaluateHookSpan(
              entry,
              buildHttpSpanData({
                activityId,
                method,
                url,
                stage: 'completed',
                requestBody,
                responseBody,
                statusCode: response.statusCode ?? null,
                startMs,
                endMs,
              }),
            ).then(
              () => replayTo(response),
              (err) => {
                req.destroy?.(err instanceof Error ? err : new Error(safeString(err)));
              },
            );
          });
        };
      }

      const req = Reflect.apply(originalRequest, this, args) as {
        write?: (...writeArgs: unknown[]) => unknown;
        end?: (...endArgs: unknown[]) => unknown;
        destroy?: (err?: Error) => unknown;
        on?: (event: string, cb: (...cbArgs: unknown[]) => void) => unknown;
      };

      // "started" gate — delays flushing the request body until the pre-flight
      // governance check resolves, mirroring patchFetch's `await evaluateHookSpan(...)`
      // before `await captured(...)`. write()/end() are synchronous APIs on
      // http.ClientRequest, so instead of blocking them directly we buffer whatever
      // the caller writes and replay it once the gate clears — a block/halt verdict
      // drops the buffered body and destroys the request instead of ever putting it
      // on the wire.
      let gateSettled = false;
      let gateError: Error | null = null;
      const pendingWrites: Array<{ end: boolean; writeArgs: unknown[] }> = [];

      const originalWrite = req.write;
      const originalEnd = req.end;

      const flushPendingWrites = () => {
        for (const pending of pendingWrites) {
          if (pending.end) {
            if (typeof originalEnd === 'function') Reflect.apply(originalEnd, req, pending.writeArgs);
          } else if (typeof originalWrite === 'function') {
            Reflect.apply(originalWrite, req, pending.writeArgs);
          }
        }
        pendingWrites.length = 0;
      };

      void evaluateHookSpan(
        entry,
        buildHttpSpanData({
          activityId,
          method,
          url,
          stage: 'started',
          requestBody: null,
          responseBody: null,
          statusCode: null,
          startMs,
        }),
      ).then(
        () => {
          gateSettled = true;
          flushPendingWrites();
        },
        (err) => {
          gateSettled = true;
          gateError = err instanceof Error ? err : new Error(safeString(err));
          pendingWrites.length = 0;
          req.destroy?.(gateError);
        },
      );

      if (typeof originalWrite === 'function') {
        req.write = function patchedWrite(...writeArgs: unknown[]) {
          captureHttpBodyChunk(reqBodyChunks, writeArgs[0]);
          if (!gateSettled) {
            pendingWrites.push({ end: false, writeArgs });
            return true;
          }
          if (gateError) return false;
          return Reflect.apply(originalWrite, this, writeArgs);
        };
      }
      if (typeof originalEnd === 'function') {
        req.end = function patchedEnd(...endArgs: unknown[]) {
          captureHttpBodyChunk(reqBodyChunks, endArgs[0]);
          if (!gateSettled) {
            pendingWrites.push({ end: true, writeArgs: endArgs });
            return req;
          }
          if (gateError) return req;
          return Reflect.apply(originalEnd, this, endArgs);
        };
      }
      req.on?.('error', (err: unknown) => {
        const endMs = Date.now();
        void evaluateHookSpan(
          entry,
          {
            ...buildHttpSpanData({
              activityId,
              method,
              url,
              stage: 'completed',
              requestBody: chunksToText(reqBodyChunks),
              responseBody: null,
              statusCode: null,
              startMs,
              endMs,
            }),
            error: safeString(err),
            status: { code: 'ERROR', description: safeString(err) },
          },
        );
      });
      return req;
    };

    mod.request = requestWrapper;
    if (typeof originalGet === 'function') {
      mod.get = function patchedGet(this: unknown, ...args: unknown[]) {
        const req = Reflect.apply(requestWrapper, this, args) as { end?: () => unknown };
        req.end?.();
        return req;
      };
    }
    return true;
  } catch {
    return false;
  }
}

function captureHttpBodyChunk(chunks: Buffer[], chunk: unknown): void {
  if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
}

function chunksToText(chunks: Buffer[]): string | null {
  return chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : null;
}

function extractHttpMethod(args: unknown[]): string {
  for (const arg of args) {
    if (arg && typeof arg === 'object' && 'method' in arg) {
      const method = (arg as Record<string, unknown>).method;
      if (typeof method === 'string') return method.toUpperCase();
    }
  }
  return 'GET';
}

function extractHttpUrl(moduleName: 'node:http' | 'node:https', args: unknown[]): string {
  const protocol = moduleName === 'node:https' ? 'https:' : 'http:';
  const first = args[0];
  try {
    if (typeof first === 'string') return first;
    if (first instanceof URL) return first.toString();
    const candidate = args.find((arg) => arg && typeof arg === 'object' && ('hostname' in arg || 'host' in arg || 'path' in arg));
    if (candidate && typeof candidate === 'object') {
      const o = candidate as Record<string, unknown>;
      // `hostname` never carries the port, `host` may. Reattach an explicit
      // port when the resolved authority lacks one, otherwise a self-hosted
      // OpenBox Core on a non-default port (http://host:9902) reconstructs as
      // http://host/... and stops matching its own ignored-URL prefix — so
      // the governance client's calls to Core get instrumented as hook spans
      // and posted back to Core, which loops.
      let authority = String(o.hostname ?? o.host ?? 'unknown');
      const port = o.port == null || o.port === '' ? '' : String(o.port);
      if (port && !authority.includes(':')) authority = `${authority}:${port}`;
      const path = String(o.path ?? '/');
      return `${String(o.protocol ?? protocol)}//${authority}${path}`;
    }
  } catch {
    // best effort
  }
  return `${protocol}//unknown/`;
}

export function setupSpanProcessorInstrumentation(options: { http?: boolean } = {}): void {
  if (options.http ?? true) {
    patchFetch();
    patchHttpModules();
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Register an LLM activity so outgoing fetch calls during its execution
 * are captured as http_request spans and sent to Core.
 *
 * Mirrors Python's:
 *   span_processor.set_activity_context(workflow_id, activity_id, context)
 *   span_processor.register_trace(trace_id, workflow_id, activity_id)
 */
export function registerActivity(
  activityId: string,
  ctx: ActivityContext,
  executeFunctions: IExecuteFunctions,
  traceId: string,
  opts: RegisterActivityOptions,
): void {
  patchFetch();
  _activeActivities.set(activityId, {
    ctx,
    executeFunctions,
    traceId,
    hitl: opts.hitl,
    onApiError: opts.onApiError,
    logger: opts.logger,
    requestTimeoutMs: opts.requestTimeoutMs,
  });
}

/**
 * Run a governed operation in an async-local activity scope.
 * Mirrors Python's trace_id → workflow/activity lookup without relying on
 * whichever registered activity happens to be first in the map.
 */
export async function runWithActivity<T>(
  activityId: string,
  handler: () => Promise<T>,
): Promise<T> {
  return _activityScope.run(activityId, handler);
}

/**
 * Clear hook-level abort state after HITL approval.
 * Mirrors span_processor.clear_activity_abort().
 */
export function clearActivityAbort(activityId: string): void {
  _activityAbort.delete(activityId);
}

/**
 * Mark an activity as approved so subsequent HTTP hook verdicts of
 * require_approval are suppressed for the rest of this tool execution.
 * Call this after pollApprovalOrHalt() returns at ToolStarted/LLMStarted level.
 */
export function markActivityApproved(activityId: string): void {
  _approvedActivities.add(activityId);
}

/**
 * True when the hook set an abort for this activity.
 * Used to detect require_approval blocks that the tool swallowed internally
 * (returned the error as a string) rather than propagating as an exception.
 */
export function hasActivityAbort(activityId: string): boolean {
  return _activityAbort.has(activityId);
}

/**
 * The reason recorded for this activity's abort (block/halt, an approval
 * rejection/expiry/timeout, or HITL-disabled), if any. Prefer this over
 * trying to introspect a caught error's message/cause chain — see
 * abortAndThrow's doc comment for why the caught error can't be trusted.
 */
export function getActivityAbortReason(activityId: string): string | undefined {
  return _activityAbort.get(activityId);
}

/**
 * True when this activity was already approved (at ToolStarted/LLMStarted level).
 * Used to skip HITL at ToolCompleted/LLMCompleted — one approval covers the full call.
 */
export function isActivityApproved(activityId: string): boolean {
  return _approvedActivities.has(activityId);
}

/**
 * Unregister an LLM activity after the model call completes.
 * Mirrors Python's span_processor.clear_activity_context().
 */
export function unregisterActivity(activityId: string): void {
  _activeActivities.delete(activityId);
  _activityAbort.delete(activityId);
  _approvedActivities.delete(activityId);
}

/**
 * Remove all lingering activity registrations for a completed workflow.
 * Mirrors Python's span_processor.unregister_workflow(workflow_id).
 * Called from handleAfterAgent as a safety net — individual activities should
 * already be cleaned up by their own unregisterActivity() calls.
 */
export function unregisterWorkflow(workflowId: string): void {
  for (const [activityId, entry] of _activeActivities) {
    if (entry.ctx.workflow_id === workflowId) {
      _activeActivities.delete(activityId);
      _activityAbort.delete(activityId);
      _approvedActivities.delete(activityId);
    }
  }
}
