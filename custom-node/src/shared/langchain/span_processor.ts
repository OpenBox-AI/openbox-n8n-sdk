/**
 * HTTP span collector — TypeScript port of otel_setup.py + http_governance_hooks.py +
 * the relevant parts of WorkflowSpanProcessor, scoped to n8n.
 *
 * The Python SDK intercepts HTTP calls via OTel httpx instrumentation and patches
 * httpx.Client.send. In Node.js 18+ (n8n's runtime), openai-node uses the native
 * fetch API (undici). We patch globalThis.fetch the same way Python patches
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
import { AsyncLocalStorage } from 'node:async_hooks';

import { openboxRequest } from '../openbox-client';
import { rfc3339Now, hexId, GovernanceVerdictResponse } from './types';
import { GovernanceBlockedError, verdictFromString } from './verdict';

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

interface ActiveEntry {
  ctx: ActivityContext;
  executeFunctions: IExecuteFunctions;
  traceId: string;
}

// Global registry keyed by activityId — only one entry active at a time per LLM call
const _activeActivities = new Map<string, ActiveEntry>();
const _activityAbort = new Map<string, string>();
const _activityScope = new AsyncLocalStorage<string>();
const _recentHttpSpans = new Map<string, number>();
const _recentHttpSpanTtlMs = 1000;

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
    },
    status: { code: error ? 'ERROR' : 'UNSET', description: error },
    events: [],
    hook_type: 'http_request',
    http_method: opts.method,
    http_url: opts.url,
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
  if (isDuplicateHttpSpan(entry.ctx.activity_id, spanData)) return;
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
      noRetry: true,
      traceId: entry.traceId,
    });
    handleHookVerdict(response, String(spanData.http_url ?? spanData.name ?? 'hook'), entry.ctx.activity_id);
  } catch (err) {
    if (err instanceof GovernanceBlockedError) throw err;
    // fail_open — governance errors must never crash the model call
  }
}

function isDuplicateHttpSpan(activityId: string, spanData: Record<string, unknown>): boolean {
  if (spanData.hook_type !== 'http_request') return false;
  const now = Date.now();
  for (const [key, seenAt] of _recentHttpSpans) {
    if (now - seenAt > _recentHttpSpanTtlMs) {
      _recentHttpSpans.delete(key);
    }
  }
  const key = [
    activityId,
    spanData.stage,
    spanData.http_method,
    spanData.http_url,
    spanData.http_status_code ?? '',
  ].join('|');
  const seenAt = _recentHttpSpans.get(key);
  if (seenAt != null && now - seenAt <= _recentHttpSpanTtlMs) {
    return true;
  }
  _recentHttpSpans.set(key, now);
  return false;
}

export async function evaluateActivitySpan(
  activityId: string,
  spanData: Record<string, unknown>,
): Promise<void> {
  const abortReason = _activityAbort.get(activityId);
  if (abortReason) {
    throw new GovernanceBlockedError('require_approval', abortReason);
  }
  const entry = _activeActivities.get(activityId);
  if (!entry) return;
  await evaluateHookSpan(entry, spanData);
}

export function getCurrentActivityId(): string | undefined {
  return _activityScope.getStore();
}

function handleHookVerdict(
  response: GovernanceVerdictResponse | null,
  identifier: string,
  activityId: string,
): void {
  if (response == null) return;
  const verdict = verdictFromString(response.verdict ?? response.arm ?? response.action);
  if (verdict === 'block' || verdict === 'halt' || verdict === 'require_approval') {
    const reason =
      response.reason ??
      (verdict === 'require_approval' ? 'Approval required - blocked at hook level' : 'Blocked by governance');
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (typeof g.fetch !== 'function') return; // Node < 18: no native fetch
  _patched = true;
  _originalFetch = g.fetch as AnyFetch;
  const captured = _originalFetch!;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  g.fetch = async function patchedFetch(input: any, init?: any): Promise<any> {
    // Fast-path: no active governed activity — skip all instrumentation.
    if (_activeActivities.size === 0) {
      return captured(input, init);
    }
    // Resolve activityId early so we can bail before any work if not found.
    const activityId = _activityScope.getStore() ?? _activeActivities.keys().next().value;
    if (!activityId || !_activeActivities.has(activityId as string)) {
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

    const abortReason = _activityAbort.get(activityId as string);
    if (abortReason) {
      throw new GovernanceBlockedError('require_approval', abortReason);
    }

    const entry = _activeActivities.get(activityId as string);
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
        const bodyTimeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000));
        responseBody = await Promise.race([
          response.clone().text().catch((): null => null),
          bodyTimeout,
        ]);
      }
    } catch { /* best effort */ }

    // Evaluate "completed" span (mirrors _patched_async_send).
    // For 'require_approval' verdicts on the completed span: _activityAbort is
    // already set by handleHookVerdict so any SUBSEQUENT fetch from this activity
    // will be blocked before it starts. We must NOT propagate the throw here —
    // the HTTP call already happened and throwing from patchedFetch for the
    // completed span causes the error to surface inside tool.invoke(), which
    // triggers a 5-minute HITL polling wait even though the underlying response
    // is already available. 'block' and 'halt' verdicts still propagate (those
    // mean "discard this response immediately").
    try {
      await evaluateHookSpan(
        entry,
        buildHttpSpanData({ activityId, method, url: urlStr, stage: 'completed', requestBody, responseBody, statusCode: response?.status ?? null, startMs, endMs }),
      );
    } catch (err) {
      if (err instanceof GovernanceBlockedError && err.verdict === 'require_approval') {
        // _activityAbort is set; next fetch will be blocked. Allow this response through.
      } else {
        throw err;
      }
    }

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
        }) => {
          const responseChunks: Buffer[] = [];
          response.on?.('data', (chunk: unknown) => captureHttpBodyChunk(responseChunks, chunk));
          response.on?.('end', () => {
            const endMs = Date.now();
            const requestBody = chunksToText(reqBodyChunks);
            const responseBody = chunksToText(responseChunks);
            void evaluateHookSpan(
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
            );
          });
          originalCallback(response);
        };
      }

      const req = Reflect.apply(originalRequest, this, args) as {
        write?: (...writeArgs: unknown[]) => unknown;
        end?: (...endArgs: unknown[]) => unknown;
        destroy?: (err?: Error) => unknown;
        on?: (event: string, cb: (...cbArgs: unknown[]) => void) => unknown;
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
      ).catch((err) => {
        req.destroy?.(err instanceof Error ? err : new Error(String(err)));
      });

      const originalWrite = req.write;
      if (typeof originalWrite === 'function') {
        req.write = function patchedWrite(...writeArgs: unknown[]) {
          captureHttpBodyChunk(reqBodyChunks, writeArgs[0]);
          return Reflect.apply(originalWrite, this, writeArgs);
        };
      }
      const originalEnd = req.end;
      if (typeof originalEnd === 'function') {
        req.end = function patchedEnd(...endArgs: unknown[]) {
          captureHttpBodyChunk(reqBodyChunks, endArgs[0]);
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
            error: String(err),
            status: { code: 'ERROR', description: String(err) },
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
      const host = String(o.hostname ?? o.host ?? 'unknown');
      const path = String(o.path ?? '/');
      return `${String(o.protocol ?? protocol)}//${host}${path}`;
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
): void {
  patchFetch();
  _activeActivities.set(activityId, { ctx, executeFunctions, traceId });
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
 * Unregister an LLM activity after the model call completes.
 * Mirrors Python's span_processor.clear_activity_context().
 */
export function unregisterActivity(activityId: string): void {
  _activeActivities.delete(activityId);
  _activityAbort.delete(activityId);
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
    }
  }
}
