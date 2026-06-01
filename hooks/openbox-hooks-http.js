/**
 * Automatic HTTP span capture via Node.js `diagnostics_channel`.
 *
 * Implements gaps.md GAP-12. The diagnostics_channel API is built
 * into Node.js 18+ and fires on every outbound HTTP request,
 * including those made by built-in n8n nodes (Slack, HubSpot, HTTP
 * Request, etc.) and any third-party node that uses the standard
 * `http`/`https` modules under the hood.
 *
 * Limitation: diagnostics_channel is observe-only. To BLOCK an
 * outbound request, the optional governance proxy sidecar (GAP-16)
 * must be deployed.
 */

'use strict';

const dc = require('node:diagnostics_channel');

const { isOpenBoxUrl, log } = require('./openbox-hooks-transport');

/**
 * Reconstruct an absolute URL string from a Node `http.ClientRequest`.
 * Different Node versions populate slightly different fields on the
 * request object, so we probe a couple of common shapes.
 */
function buildRequestUrl(request) {
  if (!request) return null;
  // Node 20+: request.host carries `host:port`; protocol/path are
  // separate. agent.protocol may be undefined for plain http.
  const protocol = request.protocol || (request.agent && request.agent.protocol) || 'http:';
  const host = request.host || (request.getHeader && request.getHeader('host')) || 'unknown';
  const path = request.path || '/';
  return `${protocol}//${host}${path}`;
}

function safeHeaders(request) {
  if (!request || typeof request.getHeaders !== 'function') return {};
  try {
    const raw = request.getHeaders();
    // Authorization headers must never be forwarded to OpenBox; they
    // belong to the upstream service the user is calling. Strip
    // anything that looks sensitive defensively.
    const out = {};
    for (const [k, v] of Object.entries(raw || {})) {
      const lower = k.toLowerCase();
      if (lower === 'authorization' || lower === 'cookie' || lower.endsWith('-api-key')) continue;
      out[k] = Array.isArray(v) ? v.join(',') : String(v);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Subscribe to the `http.client.request.*` channels and submit a
 * span on every completed outbound request. The state argument is
 * the shared `openbox-hooks-state` module so the hook can read the
 * abort flag set and the active sessions map.
 */
function subscribeHttpDiagnostics(state) {
  const { submitSpan, sessions, abortedExecutions, pendingHttpSpans } = state;

  dc.subscribe('http.client.request.start', ({ request }) => {
    try {
      const url = buildRequestUrl(request);
      if (!url) return;
      // Self-filter: never trace the OpenBox API itself or we end up
      // in an infinite POST/observe loop.
      if (isOpenBoxUrl(url)) return;

      // Phase 2.2 #7 — inject session ID so the proxy sidecar can
      // attribute this request to the right workflow execution.
      let sessionId = null;
      for (const [id] of sessions) {
        if (!abortedExecutions.has(id)) sessionId = id;
      }
      if (sessionId && typeof request.setHeader === 'function') {
        try {
          request.setHeader('X-OpenBox-Session-Id', sessionId);
        } catch {
          /* header already sent or read-only — ignore */
        }
      }

      pendingHttpSpans.set(request, {
        startTime: process.hrtime.bigint(),
        startWallMs: Date.now(),
        method: (request.method || 'GET').toUpperCase(),
        url,
        headers: safeHeaders(request),
        sessionId,
      });
    } catch (err) {
      log.debug('http.start handler failed', err);
    }
  });

  dc.subscribe('http.client.response.finish', ({ request, response }) => {
    try {
      const pending = pendingHttpSpans.get(request);
      if (!pending) return;
      pendingHttpSpans.delete(request);

      const endTime = process.hrtime.bigint();
      const durationNs = Number(endTime - pending.startTime);

      // Use the sessionId captured at request.start (injected as
      // X-OpenBox-Session-Id header); fall back to scanning sessions
      // for backwards-compat when header injection was skipped.
      let sessionId = pending.sessionId ?? null;
      if (!sessionId) {
        for (const [id] of sessions) {
          if (!abortedExecutions.has(id)) sessionId = id;
        }
      }

      void submitSpan({
        hook_type: 'http_request',
        session_id: sessionId,
        http_method: pending.method,
        http_url: pending.url,
        http_status_code: response && typeof response.statusCode === 'number'
          ? response.statusCode
          : null,
        http_request_headers: pending.headers,
        start_time_unix_ms: pending.startWallMs,
        end_time_unix_ms: pending.startWallMs + Math.floor(durationNs / 1e6),
        duration_ms: Math.floor(durationNs / 1e6),
        stage: 'completed',
      });
    } catch (err) {
      log.debug('http.finish handler failed', err);
    }
  });

  // The error channel exists on Node 20.5+; fall back gracefully if
  // it isn't available so the module still loads on older runtimes.
  try {
    dc.subscribe('http.client.request.error', ({ request, error }) => {
      try {
        const pending = pendingHttpSpans.get(request);
        if (!pending) return;
        pendingHttpSpans.delete(request);
        void submitSpan({
          hook_type: 'http_request',
          http_method: pending.method,
          http_url: pending.url,
          start_time_unix_ms: pending.startWallMs,
          end_time_unix_ms: Date.now(),
          stage: 'error',
          error: error && error.message ? error.message : String(error),
        });
      } catch (err) {
        log.debug('http.error handler failed', err);
      }
    });
  } catch {
    /* older Node — channel not available */
  }
}

module.exports = {
  subscribeHttpDiagnostics,
  // Exported for unit tests.
  __test__: { buildRequestUrl, safeHeaders },
};
