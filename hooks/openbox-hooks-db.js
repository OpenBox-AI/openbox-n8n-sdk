/**
 * Automatic Postgres span capture + optional pre-query blocking via
 * `pg.Client.prototype.query`.
 *
 * Implements gaps.md GAP-12b (observe) and Phase 3 (block).
 *
 * Observe mode (default, OPENBOX_HOOKS_DB_BLOCKING=false):
 *   Every Postgres query emits an observability span after it
 *   completes. Non-blocking, zero latency overhead.
 *
 * Blocking mode (opt-in, OPENBOX_HOOKS_DB_BLOCKING=true):
 *   Before running each query the patch calls OpenBox evaluate().
 *   If the verdict is block/halt the query is rejected with a
 *   NodeOperationError. Adds one network round-trip per query.
 *
 *   Fail policy (OPENBOX_HOOKS_DB_FAIL_OPEN=true|false, default false):
 *     false (fail-closed): OpenBox unreachable → query blocked.
 *     true  (fail-open):   OpenBox unreachable → query allowed.
 *
 * Community-edition note:
 *   EXTERNAL_HOOK_FILES is self-hosted only. On n8n Cloud neither
 *   observe nor blocking mode is available via this patch; use the
 *   explicit OpenBox node as a checkpoint instead.
 *
 * Why patch the prototype rather than the connection pool:
 *   - `pg.Pool` delegates to `pg.Client` under the hood; patching
 *     the client catches both code paths in one place.
 *   - Patching at the prototype level means we don't have to find
 *     and re-wrap every Pool/Client instance n8n creates internally.
 *
 * We deliberately keep the patch idempotent so accidental double-load
 * (n8n hot-reloads, vitest module isolation) doesn't compose the
 * tracer twice.
 */

'use strict';

const PATCH_MARKER = Symbol.for('openbox.pgPatched');

/**
 * Best-effort SQL operation classifier. Returns the leading keyword
 * (SELECT, INSERT, UPDATE, ...) so the dashboard can group queries
 * without re-parsing the statement.
 */
function classifySql(sql) {
  if (typeof sql !== 'string') return 'QUERY';
  const trimmed = sql.trim();
  if (!trimmed) return 'QUERY';
  const first = trimmed.split(/\s/, 1)[0];
  return first ? first.toUpperCase() : 'QUERY';
}

/**
 * Pull the SQL text out of pg's polymorphic query() argument list.
 * Supports query(text), query(text, values), query({text, values}),
 * and query(submittable) by best-effort.
 */
function extractSql(args) {
  if (!args || args.length === 0) return undefined;
  const a0 = args[0];
  if (typeof a0 === 'string') return a0;
  if (a0 && typeof a0 === 'object') {
    if (typeof a0.text === 'string') return a0.text;
    // Submittable QueryStream / Cursor instances expose a `text`
    // getter; otherwise leave undefined.
    if (typeof a0.toString === 'function' && a0.constructor && a0.constructor.name) {
      return `<${a0.constructor.name}>`;
    }
  }
  return undefined;
}

/**
 * Best-effort database name lookup. pg.Client carries
 * `client.database`, but pooled clients sometimes hide it on
 * `client.connectionParameters`. Falls back to `unknown` rather than
 * crash the hook.
 */
function databaseName(client) {
  if (!client) return 'unknown';
  if (typeof client.database === 'string' && client.database) return client.database;
  if (client.connectionParameters && client.connectionParameters.database) {
    return client.connectionParameters.database;
  }
  return 'unknown';
}

// Arm values that mean "do not proceed with the query".
const BLOCKING_ARMS = new Set(['block', 'halt', 'require_approval']);

/**
 * Decide whether a verdict blocks the query.
 */
function isBlockedVerdict(verdict) {
  if (!verdict || typeof verdict !== 'object') return false;
  const arm = verdict.arm || verdict.action || verdict.verdict;
  return BLOCKING_ARMS.has(arm);
}

/**
 * Wrap `pg.Client.prototype.query`. Returns the original function
 * untouched if `pg` isn't installed in n8n's runtime — that's the
 * normal case on minimal images and shouldn't be treated as an error.
 *
 * `state` must include:
 *   submitSpan, sessions, abortedExecutions  — always required
 *   evaluateQuery                            — required for blocking mode
 */
function patchPgClient(state) {
  // Lazily require so missing `pg` produces a clean message instead
  // of crashing at module load.
  let pg;
  try {
    pg = require('pg');
  } catch (err) {
    throw new Error(`pg module not available in n8n runtime: ${err.message}`);
  }

  const Client = pg && pg.Client;
  if (!Client || typeof Client.prototype.query !== 'function') {
    throw new Error('pg.Client.prototype.query not found');
  }

  if (Client.prototype[PATCH_MARKER]) {
    // Already patched in this process; do nothing.
    return;
  }

  const { submitSpan, sessions, abortedExecutions, evaluateQuery } = state;

  // Phase 3 blocking mode — opt-in only. Off by default to avoid adding
  // a network round-trip to every query in observe-only deployments and
  // to prevent accidental breakage of n8n's own internal DB operations.
  const blockingEnabled = process.env.OPENBOX_HOOKS_DB_BLOCKING === 'true';
  const failOpen = process.env.OPENBOX_HOOKS_DB_FAIL_OPEN === 'true';

  const original = Client.prototype.query;

  function tracedQuery(...args) {
    const startTime = process.hrtime.bigint();
    const startWallMs = Date.now();
    const sql = extractSql(args);
    const dbName = databaseName(this);
    const operation = classifySql(sql);

    // Skip n8n's internal query traffic (executions, credentials,
    // worker heartbeats). We can't reliably filter on table name —
    // those queries hit the configured n8n database. Emitting them
    // would 10x the span volume without adding governance value.
    const internal = dbName && /n8n/i.test(dbName);

    let sessionId = null;
    if (!internal) {
      for (const [id] of sessions) {
        if (!abortedExecutions.has(id)) sessionId = id;
      }
    }

    const finalize = (status, error) => {
      if (internal) return;
      try {
        const endTime = process.hrtime.bigint();
        const durationNs = Number(endTime - startTime);
        void submitSpan({
          hook_type: 'db_query',
          session_id: sessionId,
          db_system: 'postgresql',
          db_name: dbName,
          db_statement: sql,
          db_operation: operation,
          start_time_unix_ms: startWallMs,
          end_time_unix_ms: startWallMs + Math.floor(durationNs / 1e6),
          duration_ms: Math.floor(durationNs / 1e6),
          stage: status,
          error: error ? (error.message || String(error)) : undefined,
        });
      } catch {
        // Spans are best-effort; never let instrumentation break a
        // legitimate query.
      }
    };

    // Phase 3: pre-query blocking. We must return a Promise here because
    // evaluateQuery is async. pg handles Promise-returning query() fine —
    // callers that await or .then() the result are unaffected. The only
    // case that changes behaviour is the legacy callback form, which n8n
    // does not use for user queries (it uses async/await throughout).
    if (blockingEnabled && !internal && typeof evaluateQuery === 'function') {
      const self = this;
      return evaluateQuery({ sessionId, sql, dbName, operation }).then(
        (verdict) => {
          if (verdict === null) {
            // Transport error — apply fail policy.
            if (!failOpen) {
              const err = new Error(
                'OpenBox DB governance: query blocked (OpenBox unreachable, fail-closed)',
              );
              err.name = 'GovernanceBlockedError';
              finalize('error', err);
              throw err;
            }
            // fail-open: proceed without verdict
          } else if (isBlockedVerdict(verdict)) {
            const reason = verdict.reason || `verdict: ${verdict.arm}`;
            const err = new Error(`OpenBox DB governance: query blocked — ${reason}`);
            err.name = 'GovernanceBlockedError';
            err.verdict = verdict;
            finalize('blocked', err);
            throw err;
          }
          // Verdict allows — run the real query.
          return runQuery.call(self, args, finalize);
        },
        () => {
          // evaluateQuery itself threw — treat as transport error.
          if (!failOpen) {
            const err = new Error(
              'OpenBox DB governance: query blocked (evaluate threw, fail-closed)',
            );
            err.name = 'GovernanceBlockedError';
            finalize('error', err);
            throw err;
          }
          return runQuery.call(self, args, finalize);
        },
      );
    }

    // Observe-only path (default).
    return runQuery.call(this, args, finalize);
  }

  /**
   * Actually call the original query and hook finalize() onto the result.
   * Extracted so both the blocking and observe paths share one
   * implementation. Must be called with .call(clientInstance, ...) so
   * `this` is the pg.Client.
   */
  function runQuery(args, finalize) {
    let result;
    try {
      result = original.apply(this, args);
    } catch (sync) {
      finalize('error', sync);
      throw sync;
    }

    // pg.Client.query returns either a Submittable, a Promise, or
    // (callback form) undefined. Cover all three.
    if (result && typeof result.then === 'function') {
      return result.then(
        (value) => {
          finalize('completed');
          return value;
        },
        (err) => {
          finalize('error', err);
          throw err;
        },
      );
    }

    if (result && typeof result.on === 'function') {
      // Submittable / QueryStream — listen for end/error events.
      result.on('end', () => finalize('completed'));
      result.on('error', (err) => finalize('error', err));
      return result;
    }

    // Callback form: we never observe completion. Submit the span
    // immediately with stage `started` so at least the SQL is logged.
    finalize('started');
    return result;
  }

  Object.defineProperty(tracedQuery, PATCH_MARKER, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Client.prototype.query = tracedQuery;
  Object.defineProperty(Client.prototype, PATCH_MARKER, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: true,
  });
}

module.exports = {
  patchPgClient,
  // Exported for unit tests so they can call the helpers without
  // requiring the pg dependency.
  __test__: { classifySql, extractSql, databaseName, PATCH_MARKER },
};
