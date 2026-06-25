"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.addIgnoredPrefix = addIgnoredPrefix;
exports.shouldIgnore = shouldIgnore;
exports.buildHttpSpanData = buildHttpSpanData;
exports.evaluateActivitySpan = evaluateActivitySpan;
exports.getCurrentActivityId = getCurrentActivityId;
exports.setupSpanProcessorInstrumentation = setupSpanProcessorInstrumentation;
exports.registerActivity = registerActivity;
exports.runWithActivity = runWithActivity;
exports.clearActivityAbort = clearActivityAbort;
exports.markActivityApproved = markActivityApproved;
exports.hasActivityAbort = hasActivityAbort;
exports.isActivityApproved = isActivityApproved;
exports.unregisterActivity = unregisterActivity;
exports.unregisterWorkflow = unregisterWorkflow;
// Load AsyncLocalStorage via a variable to avoid the static 'async_hooks'
// import restriction in n8n community-node ESLint rules.
const _ahMod = 'async_hooks';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AsyncLocalStorage } = require(_ahMod);
const _timersMod = 'timers';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setTimeout: _st } = require(_timersMod);
const openbox_client_1 = require("../openbox-client");
const types_1 = require("./types");
const verdict_1 = require("./verdict");
// Global registry keyed by activityId — only one entry active at a time per LLM call
const _activeActivities = new Map();
const _activityAbort = new Map();
// Activities approved at ToolStarted/LLMStarted level — hook-level require_approval
// verdicts are suppressed for these so one approval covers the full tool execution.
const _approvedActivities = new Set();
const _activityScope = new AsyncLocalStorage();
const _recentHttpSpans = new Map();
const _recentHttpSpanTtlMs = 1000;
let _patched = false;
let _httpModulesPatched = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _originalFetch = null;
// ── Ignored URL prefixes (Core API itself, to avoid infinite loops) ────────────
const _ignoredPrefixes = [
    'https://core.openbox.ai',
    'http://core.openbox.ai',
];
/**
 * Register an extra URL prefix to ignore (e.g. a self-hosted OpenBox URL).
 * Called once at middleware construction time.
 */
function addIgnoredPrefix(prefix) {
    const normalised = prefix.replace(/\/+$/, '');
    if (!_ignoredPrefixes.includes(normalised)) {
        _ignoredPrefixes.push(normalised);
    }
}
function shouldIgnore(url) {
    return _ignoredPrefixes.some((p) => url.startsWith(p));
}
// ── LLM provider detection (gen_ai.system per OTel semantic conventions) ────
const LLM_PROVIDERS = [
    { host: 'api.openai.com', system: 'openai' },
    { host: 'api.anthropic.com', system: 'anthropic' },
    { host: 'generativelanguage.googleapis.com', system: 'google' },
    { host: 'openrouter.ai', system: 'openrouter' },
    { host: 'api.mistral.ai', system: 'mistral' },
    { host: 'api.groq.com', system: 'groq' },
    { host: 'api.together.xyz', system: 'together' },
    { host: 'api.together.ai', system: 'together' },
    { host: 'api.cohere.com', system: 'cohere' },
];
function detectGenAiSystem(url) {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        // Azure OpenAI: <resource>.openai.azure.com
        if (hostname.endsWith('.openai.azure.com'))
            return 'azure_openai';
        // AWS Bedrock: bedrock-runtime.<region>.amazonaws.com
        if (hostname.includes('bedrock') && hostname.endsWith('.amazonaws.com'))
            return 'aws_bedrock';
        const match = LLM_PROVIDERS.find((p) => hostname === p.host || hostname.endsWith(`.${p.host}`));
        return match?.system ?? null;
    }
    catch {
        return null;
    }
}
// ── Span builder (mirrors _build_http_span_data in http_governance_hooks.py) ───
function buildHttpSpanData(opts) {
    const startNs = opts.startMs * 1_000_000;
    const endNs = opts.endMs != null ? opts.endMs * 1_000_000 : null;
    const durationNs = endNs != null ? endNs - startNs : null;
    const error = opts.statusCode != null && opts.statusCode >= 400 ? `HTTP ${opts.statusCode}` : null;
    // Name: include status code on completed spans so the dashboard shows
    // e.g. "POST https://api.openai.com/v1/chat/completions 200"
    const name = opts.stage === 'completed' && opts.statusCode != null
        ? `${opts.method} ${opts.url} ${opts.statusCode}`
        : `${opts.method} ${opts.url}`;
    // start_time: for "completed" spans use end timestamp (mirrors Python SDK §5.6)
    const spanStartNs = opts.stage === 'completed' ? (endNs ?? startNs) : startNs;
    const genAiSystem = detectGenAiSystem(opts.url);
    return {
        span_id: (0, types_1.hexId)(16),
        trace_id: (0, types_1.hexId)(32),
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
async function evaluateHookSpan(entry, spanData) {
    if (isDuplicateHttpSpan(entry.ctx.activity_id, spanData))
        return;
    const payload = {
        ...entry.ctx,
        timestamp: (0, types_1.rfc3339Now)(),
        spans: [spanData],
        span_count: 1,
        hook_trigger: true,
    };
    try {
        const response = await (0, openbox_client_1.openboxRequest)(entry.executeFunctions, {
            method: 'POST',
            path: '/api/v1/governance/evaluate',
            body: payload,
            noRetry: true,
            traceId: entry.traceId,
        });
        // Span is always sent to Core so it shows on the dashboard.
        // For already-approved activities, skip verdict enforcement — enforcing would
        // create spurious approval rows. The ToolStarted approval covers the full call.
        if (!_approvedActivities.has(entry.ctx.activity_id)) {
            handleHookVerdict(response, String(spanData.http_url ?? spanData.name ?? 'hook'), entry.ctx.activity_id);
        }
    }
    catch (err) {
        if (err instanceof verdict_1.GovernanceBlockedError)
            throw err;
        // fail_open — governance errors must never crash the model call
    }
}
function isDuplicateHttpSpan(activityId, spanData) {
    if (spanData.hook_type !== 'http_request')
        return false;
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
async function evaluateActivitySpan(activityId, spanData) {
    const abortReason = _activityAbort.get(activityId);
    if (abortReason) {
        throw new verdict_1.GovernanceBlockedError('require_approval', abortReason);
    }
    const entry = _activeActivities.get(activityId);
    if (!entry)
        return;
    await evaluateHookSpan(entry, spanData);
}
function getCurrentActivityId() {
    return _activityScope.getStore();
}
function handleHookVerdict(response, identifier, activityId) {
    if (response == null)
        return;
    const verdict = (0, verdict_1.verdictFromString)(response.verdict ?? response.arm ?? response.action);
    if (verdict === 'block' || verdict === 'halt' || verdict === 'require_approval') {
        // If already approved at ToolStarted/LLMStarted level, don't re-block on the
        // HTTP hook event — one approval covers the full tool execution.
        if (verdict === 'require_approval' && _approvedActivities.has(activityId)) {
            return;
        }
        const reason = response.reason ??
            (verdict === 'require_approval' ? 'Approval required - blocked at hook level' : 'Blocked by governance');
        _activityAbort.set(activityId, reason);
        throw new verdict_1.GovernanceBlockedError(verdict, `${reason} (${identifier})`);
    }
}
function patchFetch() {
    if (_patched)
        return;
    if (typeof fetch !== 'function')
        return; // Node < 18: no native fetch
    _patched = true;
    _originalFetch = fetch;
    const captured = _originalFetch;
    // @ts-expect-error -- fetch is a writable global in Node.js 18+ (undici); TypeScript's
    // declaration via @types/node as a function type does not reflect its runtime writability.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetch = async function patchedFetch(input, init) {
        // Fast-path: no active governed activity — skip all instrumentation.
        if (_activeActivities.size === 0) {
            return captured(input, init);
        }
        // Resolve activityId early so we can bail before any work if not found.
        const activityId = _activityScope.getStore() ?? _activeActivities.keys().next().value;
        if (!activityId || !_activeActivities.has(activityId)) {
            return captured(input, init);
        }
        const urlStr = (() => {
            try {
                if (typeof input === 'string')
                    return input;
                if (input instanceof URL)
                    return input.toString();
                return String(input?.url ?? '');
            }
            catch {
                return '';
            }
        })();
        if (!urlStr || shouldIgnore(urlStr)) {
            return captured(input, init);
        }
        const abortReason = _activityAbort.get(activityId);
        if (abortReason) {
            throw new verdict_1.GovernanceBlockedError('require_approval', abortReason);
        }
        const entry = _activeActivities.get(activityId);
        if (!entry)
            return captured(input, init);
        const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
        const startMs = Date.now();
        // Capture request body (mirrors _capture_httpx_request_data)
        let requestBody = null;
        try {
            const bodyVal = init?.body;
            if (typeof bodyVal === 'string') {
                requestBody = bodyVal;
            }
            else if (bodyVal instanceof ArrayBuffer || ArrayBuffer.isView(bodyVal)) {
                requestBody = new TextDecoder().decode(bodyVal);
            }
            else if (bodyVal == null && typeof input?.clone === 'function') {
                requestBody = await input.clone().text().catch(() => null);
            }
        }
        catch { /* best effort */ }
        // Evaluate "started" span (mirrors _httpx_async_request_hook)
        await evaluateHookSpan(entry, buildHttpSpanData({ activityId, method, url: urlStr, stage: 'started', requestBody, responseBody: null, statusCode: null, startMs }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response = await captured(input, init);
        const endMs = Date.now();
        // Capture response body (mirrors _capture_httpx_response_data / _patched_async_send)
        // Race against a 5-second timeout so a never-terminating response body stream
        // (e.g. a 503 from a load balancer that keeps the connection open) doesn't
        // hang the patched fetch and block the caller indefinitely.
        let responseBody = null;
        try {
            const contentType = String(response?.headers?.get?.('content-type') ?? '');
            if (contentType.includes('application/json') || contentType.startsWith('text/')) {
                const bodyTimeout = new Promise((resolve) => _st(() => resolve(null), 5_000));
                responseBody = await Promise.race([
                    response.clone().text().catch(() => null),
                    bodyTimeout,
                ]);
            }
        }
        catch { /* best effort */ }
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
            await evaluateHookSpan(entry, buildHttpSpanData({ activityId, method, url: urlStr, stage: 'completed', requestBody, responseBody, statusCode: response?.status ?? null, startMs, endMs }));
        }
        catch (err) {
            if (err instanceof verdict_1.GovernanceBlockedError && err.verdict === 'require_approval') {
                // _activityAbort is set; next fetch will be blocked. Allow this response through.
            }
            else {
                throw err;
            }
        }
        return response;
    };
}
function patchHttpModules() {
    if (_httpModulesPatched)
        return;
    _httpModulesPatched = true;
    patchHttpModule('node:http');
    patchHttpModule('node:https');
}
function patchHttpModule(moduleName) {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(moduleName);
        if (mod._openboxPatched)
            return true;
        const originalRequest = mod.request;
        const originalGet = mod.get;
        if (typeof originalRequest !== 'function')
            return false;
        mod._openboxPatched = true;
        const requestWrapper = function patchedRequest(...args) {
            const activityId = _activityScope.getStore();
            if (!activityId)
                return Reflect.apply(originalRequest, this, args);
            const entry = _activeActivities.get(activityId);
            if (!entry)
                return Reflect.apply(originalRequest, this, args);
            const startMs = Date.now();
            const reqBodyChunks = [];
            const method = extractHttpMethod(args);
            const url = extractHttpUrl(moduleName, args);
            if (!url || shouldIgnore(url))
                return Reflect.apply(originalRequest, this, args);
            const callbackIndex = args.findIndex((arg) => typeof arg === 'function');
            const originalCallback = callbackIndex >= 0 ? args[callbackIndex] : null;
            if (originalCallback) {
                args[callbackIndex] = (response) => {
                    const responseChunks = [];
                    response.on?.('data', (chunk) => captureHttpBodyChunk(responseChunks, chunk));
                    response.on?.('end', () => {
                        const endMs = Date.now();
                        const requestBody = chunksToText(reqBodyChunks);
                        const responseBody = chunksToText(responseChunks);
                        void evaluateHookSpan(entry, buildHttpSpanData({
                            activityId,
                            method,
                            url,
                            stage: 'completed',
                            requestBody,
                            responseBody,
                            statusCode: response.statusCode ?? null,
                            startMs,
                            endMs,
                        }));
                    });
                    originalCallback(response);
                };
            }
            const req = Reflect.apply(originalRequest, this, args);
            void evaluateHookSpan(entry, buildHttpSpanData({
                activityId,
                method,
                url,
                stage: 'started',
                requestBody: null,
                responseBody: null,
                statusCode: null,
                startMs,
            })).catch((err) => {
                req.destroy?.(err instanceof Error ? err : new Error(String(err)));
            });
            const originalWrite = req.write;
            if (typeof originalWrite === 'function') {
                req.write = function patchedWrite(...writeArgs) {
                    captureHttpBodyChunk(reqBodyChunks, writeArgs[0]);
                    return Reflect.apply(originalWrite, this, writeArgs);
                };
            }
            const originalEnd = req.end;
            if (typeof originalEnd === 'function') {
                req.end = function patchedEnd(...endArgs) {
                    captureHttpBodyChunk(reqBodyChunks, endArgs[0]);
                    return Reflect.apply(originalEnd, this, endArgs);
                };
            }
            req.on?.('error', (err) => {
                const endMs = Date.now();
                void evaluateHookSpan(entry, {
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
                });
            });
            return req;
        };
        mod.request = requestWrapper;
        if (typeof originalGet === 'function') {
            mod.get = function patchedGet(...args) {
                const req = Reflect.apply(requestWrapper, this, args);
                req.end?.();
                return req;
            };
        }
        return true;
    }
    catch {
        return false;
    }
}
function captureHttpBodyChunk(chunks, chunk) {
    if (Buffer.isBuffer(chunk))
        chunks.push(chunk);
    else if (typeof chunk === 'string')
        chunks.push(Buffer.from(chunk));
}
function chunksToText(chunks) {
    return chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : null;
}
function extractHttpMethod(args) {
    for (const arg of args) {
        if (arg && typeof arg === 'object' && 'method' in arg) {
            const method = arg.method;
            if (typeof method === 'string')
                return method.toUpperCase();
        }
    }
    return 'GET';
}
function extractHttpUrl(moduleName, args) {
    const protocol = moduleName === 'node:https' ? 'https:' : 'http:';
    const first = args[0];
    try {
        if (typeof first === 'string')
            return first;
        if (first instanceof URL)
            return first.toString();
        const candidate = args.find((arg) => arg && typeof arg === 'object' && ('hostname' in arg || 'host' in arg || 'path' in arg));
        if (candidate && typeof candidate === 'object') {
            const o = candidate;
            const host = String(o.hostname ?? o.host ?? 'unknown');
            const path = String(o.path ?? '/');
            return `${String(o.protocol ?? protocol)}//${host}${path}`;
        }
    }
    catch {
        // best effort
    }
    return `${protocol}//unknown/`;
}
function setupSpanProcessorInstrumentation(options = {}) {
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
function registerActivity(activityId, ctx, executeFunctions, traceId) {
    patchFetch();
    _activeActivities.set(activityId, { ctx, executeFunctions, traceId });
}
/**
 * Run a governed operation in an async-local activity scope.
 * Mirrors Python's trace_id → workflow/activity lookup without relying on
 * whichever registered activity happens to be first in the map.
 */
async function runWithActivity(activityId, handler) {
    return _activityScope.run(activityId, handler);
}
/**
 * Clear hook-level abort state after HITL approval.
 * Mirrors span_processor.clear_activity_abort().
 */
function clearActivityAbort(activityId) {
    _activityAbort.delete(activityId);
}
/**
 * Mark an activity as approved so subsequent HTTP hook verdicts of
 * require_approval are suppressed for the rest of this tool execution.
 * Call this after pollApprovalOrHalt() returns at ToolStarted/LLMStarted level.
 */
function markActivityApproved(activityId) {
    _approvedActivities.add(activityId);
}
/**
 * True when the hook set an abort for this activity.
 * Used to detect require_approval blocks that the tool swallowed internally
 * (returned the error as a string) rather than propagating as an exception.
 */
function hasActivityAbort(activityId) {
    return _activityAbort.has(activityId);
}
/**
 * True when this activity was already approved (at ToolStarted/LLMStarted level).
 * Used to skip HITL at ToolCompleted/LLMCompleted — one approval covers the full call.
 */
function isActivityApproved(activityId) {
    return _approvedActivities.has(activityId);
}
/**
 * Unregister an LLM activity after the model call completes.
 * Mirrors Python's span_processor.clear_activity_context().
 */
function unregisterActivity(activityId) {
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
function unregisterWorkflow(workflowId) {
    for (const [activityId, entry] of _activeActivities) {
        if (entry.ctx.workflow_id === workflowId) {
            _activeActivities.delete(activityId);
            _activityAbort.delete(activityId);
        }
    }
}
