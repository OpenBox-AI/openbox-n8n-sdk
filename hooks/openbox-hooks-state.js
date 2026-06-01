/**
 * Module-level state for `openbox-hooks.js`.
 *
 * Mirrors the Python SDK's `WorkflowSpanProcessor` design (gaps.md
 * GAP-13): a single shared registry keyed by session id, a
 * pendingHttpSpans WeakMap keyed by the diagnostics_channel request
 * object, and a cheap Set for HALT abort flags.
 *
 * Splitting state into its own module makes unit-testing trivial
 * (require fresh copies via vitest's resetModules) and keeps the
 * lifecycle hooks file free of mutable globals.
 */

'use strict';

module.exports = {
  /**
   * Shared "did n8n.ready fire successfully?" gate. preExecute and
   * postExecute consult this to make sure they don't try to submit
   * spans before the diagnostics_channel subscription is active.
   */
  hooks: { ready: false },

  /**
   * sessionId -> session record. Created in workflow.preExecute,
   * cleared in workflow.postExecute. The HTTP and DB hooks read this
   * map to attribute spans to a workflow.
   */
  sessions: new Map(),

  /**
   * sessionIds whose verdict came back as HALT. The hooks check this
   * set before submitting any span; once a session is aborted, we
   * stop generating governance traffic for it. This is the closest
   * approximation of Temporal's `abort_flag` available in n8n, given
   * that n8n exposes no API to terminate an in-flight execution.
   */
  abortedExecutions: new Set(),

  /**
   * WeakMap keyed by the http(s).ClientRequest object that
   * diagnostics_channel emits on `http.client.request.start`. Holds
   * the partial span until the matching `http.client.response.finish`
   * event arrives. WeakMap means we don't have to manually evict
   * entries when a request is GC'd mid-flight.
   */
  pendingHttpSpans: new WeakMap(),
};
