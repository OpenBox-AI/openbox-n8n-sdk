/**
 * Transport layer for the OpenBox external hooks.
 *
 * Wraps the global `fetch` available since Node.js 18 with:
 *   - URL self-filtering (never POST a span describing the request
 *     that submitted it; that would be an infinite recursion)
 *   - Bounded concurrency via a tiny in-memory queue, so a burst of
 *     spans cannot exhaust file descriptors or backpressure n8n
 *   - A short timeout per submission; spans are best-effort
 *     telemetry, not transactional writes
 *   - Circuit breaker: after CIRCUIT_FAILURE_THRESHOLD consecutive
 *     failures the transport switches to fail-fast mode for
 *     CIRCUIT_COOLDOWN_MS before retrying. Prevents every workflow
 *     execution from incurring a 5-second timeout per span when
 *     OpenBox Core is unreachable. (NEW-7)
 *
 * Does NOT use the openbox-sdk SDK client — that package is ESM-only
 * and the hooks file is loaded via CommonJS by n8n's external hooks
 * loader. Going through bare fetch keeps this module self-contained.
 */

'use strict';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_INFLIGHT = 16;

// Circuit-breaker configuration (NEW-7)
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 30_000;

const apiUrlRaw = process.env.OPENBOX_API_URL || '';
const apiUrl = apiUrlRaw.replace(/\/+$/, '');
const apiKey = process.env.OPENBOX_API_KEY || '';
const debug = process.env.OPENBOX_HOOKS_DEBUG === 'true';

let inflight = 0;
const pendingQueue = [];

// Circuit-breaker state
let consecutiveFailures = 0;
let circuitOpenUntil = 0; // epoch-ms; 0 means closed

function logPrefix(level) {
  return `[openbox-hooks][${level}]`;
}

const log = {
  info: (...args) => console.log(logPrefix('info'), ...args),
  warn: (...args) => console.warn(logPrefix('warn'), ...args),
  error: (...args) => console.error(logPrefix('error'), ...args),
  debug: (...args) => {
    if (debug) console.log(logPrefix('debug'), ...args);
  },
};

/**
 * Determine whether a URL points at the OpenBox API itself. Used by
 * the HTTP capture hook so we don't recursively trace span
 * submissions. Tolerates missing / malformed URLs.
 */
function isOpenBoxUrl(url) {
  if (!url || !apiUrl) return false;
  try {
    return url.startsWith(apiUrl);
  } catch {
    return false;
  }
}

async function dispatch(path, body) {
  if (!apiUrl || !apiKey) return;

  // Circuit-breaker: fail fast when Core has been unreachable recently (NEW-7)
  if (circuitOpenUntil > 0) {
    if (Date.now() < circuitOpenUntil) {
      log.debug(`circuit open; dropping span (resets in ${Math.ceil((circuitOpenUntil - Date.now()) / 1000)}s)`);
      return;
    }
    // Cooldown elapsed — half-open: allow one probe through
    circuitOpenUntil = 0;
    log.info('circuit breaker half-open; probing OpenBox Core');
  }

  if (inflight >= MAX_INFLIGHT) {
    // Drop spans rather than queue indefinitely. Hooks must not
    // accumulate unbounded memory if Core is unreachable.
    log.debug('inflight cap reached; dropping span');
    return;
  }

  inflight += 1;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let ok = false;
    try {
      const res = await fetch(`${apiUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-OpenBox-Source': 'n8n-external-hook',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      ok = res.ok || res.status < 500; // 4xx are valid responses; only network/5xx opens circuit
      if (!res.ok && debug) {
        const text = await res.text().catch(() => '');
        log.debug(`POST ${path} -> ${res.status} ${res.statusText}: ${text}`);
      }
    } finally {
      clearTimeout(timer);
    }
    // Successful dispatch resets the failure counter
    if (ok) consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures += 1;
    log.debug(`dispatch ${path} failed (failures=${consecutiveFailures}):`, err && err.message ? err.message : err);
    if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
      log.warn(
        `circuit breaker OPEN after ${consecutiveFailures} consecutive failures; ` +
        `will retry in ${CIRCUIT_COOLDOWN_MS / 1000}s`,
      );
      consecutiveFailures = 0; // reset counter so next probe starts fresh
    }
  } finally {
    inflight -= 1;
    const next = pendingQueue.shift();
    if (next) next();
  }
}

/**
 * Submit a single observability span. Body shape mirrors the Python
 * SDK's `submit_span` payload so server-side ingestion code can
 * remain language-agnostic.
 */
async function submitSpan(span) {
  if (!span) return;
  return dispatch('/api/v1/governance/spans', {
    source: 'n8n-external-hook',
    ...span,
  });
}

/**
 * Submit a workflow-scoped governance lifecycle event
 * (WorkflowStarted / WorkflowCompleted / WorkflowFailed).
 * Mirrors the same envelope the community node uses against
 * /api/v1/governance/evaluate.
 */
async function submitGovernanceEvent(event) {
  if (!event) return;
  return dispatch('/api/v1/governance/evaluate', {
    task_queue: 'n8n',
    metadata: { source: 'n8n-external-hook' },
    ...event,
  });
}

/**
 * Phase 3 — Pre-query governance verdict for DB blocking.
 *
 * Unlike `dispatch` (fire-and-forget), this returns the parsed verdict
 * body so the caller can decide whether to allow or block the query.
 * Uses its own fetch so it bypasses the inflight queue — a blocked DB
 * call must not be silently dropped due to back-pressure.
 *
 * Returns `null` on any transport error so callers can apply their own
 * fail-open / fail-closed policy via the `OPENBOX_HOOKS_DB_FAIL_OPEN`
 * env var.
 */
async function evaluateQuery({ sessionId, sql, dbName, operation }) {
  if (!apiUrl || !apiKey) return null;

  // Circuit-breaker: respect the same open state as the span transport.
  if (circuitOpenUntil > 0 && Date.now() < circuitOpenUntil) {
    log.debug('circuit open; skipping pre-query evaluate');
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiUrl}/api/v1/governance/evaluate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-OpenBox-Source': 'n8n-external-hook',
      },
      body: JSON.stringify({
        workflow_id: sessionId || 'n8n-db-hook',
        workflow_type: 'n8n.DbQuery',
        task_queue: 'n8n',
        event_type: 'ActivityStarted',
        activity_type: `DB:${operation || 'QUERY'}`,
        activity_stage: 'pre',
        payload: {
          input: [{
            db_system: 'postgresql',
            db_name: dbName,
            db_statement: sql,
            db_operation: operation,
          }],
        },
        metadata: { source: 'n8n-external-hook' },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait for all in-flight dispatches to settle (or time out at 5 s).
 * Called from the `n8n.stop` hook so spans queued during the last
 * workflow execution are not silently discarded on shutdown. (NEW-8)
 */
function drainAndFlush() {
  if (inflight === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const DRAIN_TIMEOUT_MS = 5000;
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    function check() {
      if (inflight === 0 || Date.now() >= deadline) {
        resolve();
      } else {
        setTimeout(check, 100);
      }
    }
    check();
  });
}

module.exports = {
  submitSpan,
  submitGovernanceEvent,
  evaluateQuery,
  isOpenBoxUrl,
  drainAndFlush,
  log,
  // Exposed for unit tests so they can assert on the URL filter logic
  // without hitting the network.
  __test__: {
    apiUrl,
    getCircuitState: () => ({ consecutiveFailures, circuitOpenUntil }),
  },
};
