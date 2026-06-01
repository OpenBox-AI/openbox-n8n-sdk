/**
 * OpenBox external hooks for self-hosted n8n.
 *
 * Loaded via the `EXTERNAL_HOOK_FILES` environment variable. Closes
 * the four observability gaps that the community node alone cannot
 * cover (see gaps.md Part 3, Phase 2):
 *
 *   GAP-10  workflow.preExecute / workflow.postExecute
 *   GAP-12  diagnostics_channel HTTP span capture
 *   GAP-12b pg.Client.prototype.query patch for DB span capture
 *   GAP-13  module-level session registry + abort flags
 *
 * Self-imposed constraints:
 *   - Pure CommonJS, no external deps (n8n's `EXTERNAL_HOOK_FILES`
 *     loader does not run npm install; transitive deps are loaded
 *     from n8n's own node_modules at best-effort).
 *   - Observe-only: this module never throws inside an n8n hook —
 *     a thrown error here would crash the worker. Errors are logged
 *     and swallowed.
 *   - Self-filter: every span body MUST exclude requests targeting
 *     OPENBOX_API_URL itself, otherwise the hook becomes a recursive
 *     fountain of spans about the spans it just submitted.
 *
 * Configuration (env vars; all optional unless noted):
 *   OPENBOX_API_URL       (required) Base URL of OpenBox Core.
 *   OPENBOX_API_KEY       (required) Agent API key.
 *   OPENBOX_HOOKS_ENABLED Set to "false" to disable the entire module.
 *   OPENBOX_HOOKS_HTTP    Set to "false" to disable HTTP span capture.
 *   OPENBOX_HOOKS_DB      Set to "false" to disable DB span capture.
 *   OPENBOX_HOOKS_DEBUG   Set to "true" for verbose logging.
 */

'use strict';

const { hooks, sessions, abortedExecutions, pendingHttpSpans } = require('./openbox-hooks-state');
const { submitSpan, submitGovernanceEvent, evaluateQuery, drainAndFlush, log } = require('./openbox-hooks-transport');
const { subscribeHttpDiagnostics } = require('./openbox-hooks-http');
const { patchPgClient } = require('./openbox-hooks-db');

const ENABLED = process.env.OPENBOX_HOOKS_ENABLED !== 'false';
const HTTP_ENABLED = process.env.OPENBOX_HOOKS_HTTP !== 'false';
const DB_ENABLED = process.env.OPENBOX_HOOKS_DB !== 'false';

/**
 * Resolve a stable identifier for the workflow run. n8n's external
 * `workflow.preExecute` hook fires BEFORE the execution ID is
 * assigned, so we synthesize one keyed on `(workflow.id, Date.now())`
 * and remember it on the workflow object via a non-enumerable Symbol.
 * postExecute then receives both the run object (with the real
 * execution id) and the workflowData; we pair the two via the same
 * Symbol so the lifecycle events stay correlated.
 */
const SESSION_KEY = Symbol.for('openbox.sessionId');

function ensureSessionId(workflow) {
  if (!workflow) return null;
  if (workflow[SESSION_KEY]) return workflow[SESSION_KEY];
  const id = `${workflow.id ?? 'unknown'}-${Date.now()}`;
  Object.defineProperty(workflow, SESSION_KEY, {
    value: id,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return id;
}

/**
 * Shared init logic for both `n8n.ready` and `worker.ready`. (F1, NEW-1)
 * Validates the API key format, subscribes HTTP/DB instrumentation, and
 * sets the `hooks.ready` gate so pre/postExecute handlers activate.
 */
async function initHooks() {
  if (!ENABLED) {
    log.info('disabled via OPENBOX_HOOKS_ENABLED=false; skipping all instrumentation');
    return;
  }

  const apiUrl = process.env.OPENBOX_API_URL;
  const apiKey = process.env.OPENBOX_API_KEY;

  if (!apiUrl || !apiKey) {
    log.warn('OPENBOX_API_URL and OPENBOX_API_KEY must both be set; hooks loaded but inert.');
    return;
  }

  // F1 / Phase 2.1 #2 — API key format validation
  if (!/^obx_(live|test)_/.test(apiKey)) {
    log.warn(
      'OPENBOX_API_KEY format invalid (expected obx_live_* or obx_test_*); ' +
      'governance events may be rejected by the server.',
    );
  }

  if (HTTP_ENABLED) {
    try {
      subscribeHttpDiagnostics({ submitSpan, sessions, abortedExecutions, pendingHttpSpans });
      log.info('HTTP span capture enabled (diagnostics_channel)');
    } catch (err) {
      log.error('failed to subscribe to HTTP diagnostics_channel', err);
    }
  }

  if (DB_ENABLED) {
    try {
      patchPgClient({ submitSpan, evaluateQuery, sessions, abortedExecutions });
      const dbBlocking = process.env.OPENBOX_HOOKS_DB_BLOCKING === 'true';
      log.info(
        `DB span capture enabled (pg patch) — blocking=${dbBlocking}, ` +
        `failOpen=${process.env.OPENBOX_HOOKS_DB_FAIL_OPEN === 'true'}`,
      );
    } catch (err) {
      // pg may legitimately not be installed in n8n's node_modules
      // (Cloud / minimal images). Log at info, not error.
      log.info(`DB span capture skipped: ${err && err.message ? err.message : err}`);
    }
  }

  hooks.ready = true;
}

module.exports = {
  n8n: {
    ready: [
      async function openboxReady() {
        await initHooks();
      },
    ],

    // NEW-8: drain in-flight spans before the process exits so the last
    // workflow execution's telemetry is not silently discarded.
    stop: [
      async function openboxStop() {
        if (!ENABLED || !hooks.ready) return;
        try {
          log.info('n8n stopping — draining pending spans...');
          await drainAndFlush();
          log.info('span drain complete');
        } catch (err) {
          log.error('stop hook drain failed', err);
        }
      },
    ],
  },

  // NEW-2: fires after all active (scheduled/trigger) workflows have been
  // polled and reactivated on startup. Emits a telemetry event so OpenBox
  // knows which workflows are live after a restart.
  activeWorkflows: {
    initialized: [
      async function openboxActiveWorkflowsInitialized() {
        if (!ENABLED || !hooks.ready) return;
        try {
          await submitGovernanceEvent({
            event_type: 'WorkflowsReactivated',
            metadata: { source: 'n8n-external-hook' },
          });
          log.info('WorkflowsReactivated event sent');
        } catch (err) {
          log.error('activeWorkflows.initialized hook failed', err);
        }
      },
    ],
  },

  // NEW-1: worker.ready fires on queue-mode worker processes. Re-running
  // initHooks() ensures observability is active on workers too.
  worker: {
    ready: [
      async function openboxWorkerReady() {
        await initHooks();
      },
    ],
  },

  workflow: {
    preExecute: [
      async function openboxWorkflowPreExecute(workflow, mode) {
        if (!ENABLED || !hooks.ready) return;
        try {
          const sessionId = ensureSessionId(workflow);
          if (!sessionId) return;
          sessions.set(sessionId, {
            workflowId: workflow.id ?? null,
            workflowName: workflow.name ?? null,
            mode: mode ?? null,
            startTime: Date.now(),
            spans: [],
          });
          await submitGovernanceEvent({
            event_type: 'WorkflowStarted',
            workflow_id: sessionId,
            workflow_type: workflow.name ?? 'n8n.Workflow',
            mode: mode ?? null,
          });
        } catch (err) {
          log.error('preExecute hook failed', err);
        }
      },
    ],

    postExecute: [
      async function openboxWorkflowPostExecute(run, workflowData) {
        if (!ENABLED || !hooks.ready) return;
        try {
          const sessionId =
            (workflowData && workflowData[SESSION_KEY]) ||
            (run && run.workflowData && run.workflowData[SESSION_KEY]);
          if (!sessionId) return;

          const session = sessions.get(sessionId);
          const status = run && run.status ? run.status : 'unknown';
          const eventType = status === 'success' ? 'WorkflowCompleted' : 'WorkflowFailed';

          // F4 / Phase 2.1 #1 — extract full error detail for WorkflowFailed
          let errorPayload;
          if (eventType === 'WorkflowFailed') {
            const topError = run?.data?.resultData?.error;
            const lastNode = run?.data?.resultData?.lastNodeExecuted;
            const nodeError =
              lastNode && run?.data?.resultData?.runData?.[lastNode]?.[0]?.error;
            const error = topError ?? nodeError;
            if (error) {
              errorPayload = {
                message: error.message ?? null,
                name: error.name ?? null,
                stack: error.stack ?? null,
                node_name: lastNode ?? error.node ?? null,
                type: error.type ?? null,
              };
            }
          }

          await submitGovernanceEvent({
            event_type: eventType,
            workflow_id: sessionId,
            execution_id: run && run.id ? run.id : null,
            workflow_type: (workflowData && workflowData.name) || 'n8n.Workflow',
            status,
            duration_ms: session ? Date.now() - session.startTime : null,
            span_count: session ? session.spans.length : 0,
            ...(errorPayload ? { error: errorPayload } : {}),
          });

          sessions.delete(sessionId);
          // Abort flag was scoped to this session; clearing it here
          // prevents stale entries from accumulating in the Set.
          abortedExecutions.delete(sessionId);
        } catch (err) {
          log.error('postExecute hook failed', err);
        }
      },
    ],

    // NEW-3 / Phase 2.2 #10 — workflow CRUD audit trail
    beforeCreate: [
      async function openboxWorkflowBeforeCreate(workflowData) {
        if (!ENABLED || !hooks.ready) return;
        try {
          await submitGovernanceEvent({
            event_type: 'WorkflowCreating',
            workflow_id: workflowData && workflowData.id ? String(workflowData.id) : null,
            workflow_type: (workflowData && workflowData.name) || 'n8n.Workflow',
          });
        } catch (err) {
          log.error('workflow.beforeCreate hook failed', err);
        }
      },
    ],

    afterCreate: [
      async function openboxWorkflowAfterCreate(workflowId) {
        if (!ENABLED || !hooks.ready) return;
        try {
          await submitGovernanceEvent({
            event_type: 'WorkflowCreated',
            workflow_id: workflowId ? String(workflowId) : null,
          });
        } catch (err) {
          log.error('workflow.afterCreate hook failed', err);
        }
      },
    ],

    update: [
      async function openboxWorkflowUpdate(workflowData) {
        if (!ENABLED || !hooks.ready) return;
        try {
          await submitGovernanceEvent({
            event_type: 'WorkflowUpdated',
            workflow_id: workflowData && workflowData.id ? String(workflowData.id) : null,
            workflow_type: (workflowData && workflowData.name) || 'n8n.Workflow',
          });
        } catch (err) {
          log.error('workflow.update hook failed', err);
        }
      },
    ],

    afterDelete: [
      async function openboxWorkflowAfterDelete(workflowId) {
        if (!ENABLED || !hooks.ready) return;
        try {
          await submitGovernanceEvent({
            event_type: 'WorkflowDeleted',
            workflow_id: workflowId ? String(workflowId) : null,
          });
        } catch (err) {
          log.error('workflow.afterDelete hook failed', err);
        }
      },
    ],
  },

  // Phase 2.2 #10 — credential change audit trail (NEW-3)
  credentials: {
    create: [
      async function openboxCredentialCreate(credentialData) {
        if (!ENABLED || !hooks.ready) return;
        try {
          await submitGovernanceEvent({
            event_type: 'CredentialCreated',
            metadata: {
              credential_id: credentialData && credentialData.id ? String(credentialData.id) : null,
              credential_type: (credentialData && credentialData.type) || null,
              credential_name: (credentialData && credentialData.name) || null,
            },
          });
        } catch (err) {
          log.error('credentials.create hook failed', err);
        }
      },
    ],

    update: [
      async function openboxCredentialUpdate(credentialData) {
        if (!ENABLED || !hooks.ready) return;
        try {
          await submitGovernanceEvent({
            event_type: 'CredentialUpdated',
            metadata: {
              credential_id: credentialData && credentialData.id ? String(credentialData.id) : null,
              credential_type: (credentialData && credentialData.type) || null,
              credential_name: (credentialData && credentialData.name) || null,
            },
          });
        } catch (err) {
          log.error('credentials.update hook failed', err);
        }
      },
    ],

    delete: [
      async function openboxCredentialDelete(credentialId) {
        if (!ENABLED || !hooks.ready) return;
        try {
          await submitGovernanceEvent({
            event_type: 'CredentialDeleted',
            metadata: {
              credential_id: credentialId ? String(credentialId) : null,
            },
          });
        } catch (err) {
          log.error('credentials.delete hook failed', err);
        }
      },
    ],
  },
};
