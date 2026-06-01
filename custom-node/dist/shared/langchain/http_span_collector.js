"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateActivitySpan = evaluateActivitySpan;
exports.getCurrentActivityId = getCurrentActivityId;
exports.registerActivity = registerActivity;
exports.runWithActivity = runWithActivity;
exports.clearActivityAbort = clearActivityAbort;
exports.unregisterActivity = unregisterActivity;
const node_async_hooks_1 = require("node:async_hooks");
const openbox_client_1 = require("../openbox-client");
const types_1 = require("./types");
const verdict_1 = require("./verdict");
// Global registry keyed by activityId — only one entry active at a time per LLM call
const _activeActivities = new Map();
const _activityAbort = new Map();
const _activityScope = new node_async_hooks_1.AsyncLocalStorage();
let _patched = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _originalFetch = null;
// ── Ignored URL prefixes (Core API itself, to avoid infinite loops) ────────────
const _ignoredPrefixes = [
    'https://core.openbox.ai',
    'http://core.openbox.ai',
];
function shouldIgnore(url) {
    return _ignoredPrefixes.some((p) => url.startsWith(p));
}
// ── Span builder (mirrors _build_http_span_data in http_governance_hooks.py) ───
function buildHttpSpanData(opts) {
    const startNs = opts.startMs * 1_000_000;
    const endNs = opts.endMs != null ? opts.endMs * 1_000_000 : null;
    const durationNs = endNs != null ? endNs - startNs : null;
    const error = opts.statusCode != null && opts.statusCode >= 400 ? `HTTP ${opts.statusCode}` : null;
    return {
        span_id: (0, types_1.hexId)(16),
        trace_id: (0, types_1.hexId)(32),
        parent_span_id: null,
        name: `${opts.method} ${opts.url}`,
        kind: 'CLIENT',
        stage: opts.stage,
        start_time: startNs,
        end_time: endNs,
        duration_ns: durationNs,
        attributes: {
            'http.method': opts.method,
            'http.url': opts.url,
            'gen_ai.system': 'n8n',
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
async function evaluateHookSpan(entry, spanData) {
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
        handleHookVerdict(response, String(spanData.http_url ?? spanData.name ?? 'hook'), entry.ctx.activity_id);
    }
    catch (err) {
        if (err instanceof verdict_1.GovernanceBlockedError)
            throw err;
        // fail_open — governance errors must never crash the model call
    }
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
        const reason = response.reason ??
            (verdict === 'require_approval' ? 'Approval required - blocked at hook level' : 'Blocked by governance');
        _activityAbort.set(activityId, reason);
        throw new verdict_1.GovernanceBlockedError(verdict, `${reason} (${identifier})`);
    }
}
function patchFetch() {
    if (_patched)
        return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis;
    if (typeof g.fetch !== 'function')
        return; // Node < 18: no native fetch
    _patched = true;
    _originalFetch = g.fetch;
    const captured = _originalFetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    g.fetch = async function patchedFetch(input, init) {
        if (_activeActivities.size === 0) {
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
        const activityId = _activityScope.getStore() ?? _activeActivities.keys().next().value;
        if (!activityId)
            return captured(input, init);
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
        let responseBody = null;
        try {
            const contentType = String(response?.headers?.get?.('content-type') ?? '');
            if (contentType.includes('application/json') || contentType.startsWith('text/')) {
                responseBody = await response.clone().text().catch(() => null);
            }
        }
        catch { /* best effort */ }
        // Evaluate "completed" span (mirrors _patched_async_send)
        await evaluateHookSpan(entry, buildHttpSpanData({ activityId, method, url: urlStr, stage: 'completed', requestBody, responseBody, statusCode: response?.status ?? null, startMs, endMs }));
        return response;
    };
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
 * Unregister an LLM activity after the model call completes.
 * Mirrors Python's span_processor.clear_activity_context().
 */
function unregisterActivity(activityId) {
    _activeActivities.delete(activityId);
    _activityAbort.delete(activityId);
}
