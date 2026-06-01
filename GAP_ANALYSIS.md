# OpenBox n8n Demo — Full Gap Analysis & Feasibility Assessment

> **Updated:** Post n8n source code + docs audit (n8n `master`, May 2026)
>
> This document supersedes the previous gap analysis. It maps the n8n demo against the **SDK Design Reference** (`sdk-design-reference.md`) and the **Python Temporal SDK**, confirmed against the **complete n8n `ExternalHooksMap` type signature** from the live n8n source (`packages/cli/src/external-hooks.ts`) and n8n community/docs research.

---

## Confirmed n8n External Hook Namespace Inventory

From the live `ExternalHooksMap` in n8n `master`:

| Hook | Signature | Notes |
|:---|:---|:---|
| `n8n.ready` | `[server: AbstractServer, config: Config]` | Server/app is up; safe to register custom API endpoints |
| `n8n.stop` | `never` | Process shutting down |
| `worker.ready` | `never` | n8n worker process ready |
| `activeWorkflows.initialized` | `never` | All active workflow polls loaded |
| `credentials.create` | `[encryptedData: ICredentialsDb]` | Before credential is stored |
| `credentials.update` | `[newCredentialData: ICredentialsDb]` | Before credential is updated |
| `credentials.delete` | `[credentialId: string]` | Before credential is deleted |
| `frontend.settings` | `[frontendSettings: FrontendSettings]` | Override frontend config at startup |
| `mfa.beforeSetup` | `[user: User]` | Before MFA enrollment |
| `oauth1.authenticate` | `[oAuthOptions, oauthRequestData]` | OAuth1 flow |
| `oauth2.authenticate` | `[oAuthOptions: ClientOAuth2Options]` | OAuth2 flow |
| `oauth2.callback` | `[oAuthOptions: ClientOAuth2Options]` | OAuth2 callback |
| `oauth2.dynamicClientRegistration` | `[registerPayload]` | Dynamic client reg |
| `tag.beforeCreate` | `[tag: TagEntity]` | Before tag creation |
| `tag.afterCreate` | `[tag: TagEntity]` | After tag creation |
| `tag.beforeUpdate` | `[tag: TagEntity]` | Before tag update |
| `tag.afterUpdate` | `[tag: TagEntity]` | After tag update |
| `tag.beforeDelete` | `[tagId: string]` | Before tag deletion |
| `workflow.preExecute` | `[workflow: Workflow, mode: WorkflowExecuteMode]` | Before execution starts; **throw to abort** |
| `workflow.postExecute` | `[run: IRun, workflowData: IWorkflowBase]` | After execution completes (throw is logged, does NOT undo) |
| `workflow.activate` | `[workflowData: IWorkflowDb]` | Before workflow activated |
| `workflow.beforeCreate` | `[workflowData: IWorkflowDb]` | Before a new workflow is first saved |
| `workflow.afterCreate` | `[workflowId: string]` | After a new workflow is saved |
| `workflow.update` | `[workflowData: IWorkflowDb]` | Before an existing workflow is saved |
| `workflow.afterDelete` | `[workflowId: string]` | After workflow deleted |

> [!IMPORTANT]
> **There is no `node.preExecute`, `node.postExecute`, or any per-node interception hook in the n8n external hook system.** This is confirmed from the source; it is a hard platform constraint. Internal `nodeExecuteBefore`/`nodeExecuteAfter` hooks exist inside `WorkflowHooks` but are **not** exposed via `EXTERNAL_HOOK_FILES`.

> [!IMPORTANT]
> **Queue-mode critical caveat:** When running n8n with `N8N_MODE=queue` (separate worker processes), `EXTERNAL_HOOK_FILES` is loaded on the **main process only**. Worker processes that actually execute workflows do NOT load external hooks. `workflow.preExecute` and `workflow.postExecute` may NOT fire on worker-executed workflows.

> [!NOTE]
> **`workflow.preExecute` fires BEFORE the execution ID is assigned** — the execution ID is only available in `workflow.postExecute` via `run.id`. The `openbox-hooks.js` already works around this with a synthesized `SESSION_KEY` symbol.

> [!NOTE]
> **Correct error access path in `workflow.postExecute`:** Extract error objects from `run.data.resultData.error` inside the n8n postExecute hook, map them to the `WorkflowFailed` event payload, and forward them to the API. Also check per-node errors at `run.data.resultData.runData[run.data.resultData.lastNodeExecuted]`.

---

## Complete Feature Matrix

| # | Feature Area | SDK Spec | n8n Demo | Status | Feasibility |
|:--|:---|:---|:---|:---|:---|
| F1 | **API Key Validation** | Format check (`obx_live_*`), HTTPS enforcement, startup ping to `/api/v1/auth/validate` | ✅ Format regex + warning added to `n8n.ready` (and `worker.ready`) in hooks module. | ✅ Done | — |
| F2 | **WorkflowStarted event** | Sent via activity before workflow body runs | Sent via `workflow.preExecute` hook | ✅ Implemented | — |
| F3 | **WorkflowCompleted event** | Sent after successful workflow return | Sent via `workflow.postExecute` when `run.status === 'success'` | ✅ Implemented | — |
| F4 | **WorkflowFailed event** | Includes full error chain + stack trace | ✅ Full error detail extracted: `message`, `name`, `stack`, `node_name`, `type` from `run.data.resultData.error` | ✅ Done | — |
| F5 | **SignalReceived event** | Intercept inbound signals, cache blocking verdicts | No equivalent in n8n | ❌ Missing | 🔴 Not Feasible — n8n has no external signal hook. Webhook nodes are the closest analog; they can be documented as the n8n equivalent but require explicit node design. |
| F6 | **Per-activity/node interception** | `ActivityInboundInterceptor` wraps every activity automatically | Manual checkpoint nodes (OpenBox generic + LLM node) | ❌ Not Feasible | 🔴 Platform constraint — n8n does not expose per-node lifecycle hooks in `EXTERNAL_HOOK_FILES`. Proxy sidecar partially mitigates for HTTP. |
| F7 | **Verdict Priority Routing** | `halt > block > guardrails > require_approval > constrain > allow` | Implemented correctly in both custom nodes | ✅ Implemented | — |
| F8 | **Halt Enforcement** | `client.terminate()` on Temporal workflow | Routes to `Halted` output or throws. No execution cancellation API. | ⚠️ Partial | 🔴 Not Feasible natively — n8n REST API can cancel executions (`DELETE /api/v1/executions/:id`) but this cannot be called from within the running execution itself via hooks. Would require a sidecar calling the n8n API. |
| F9 | **HTTP Observe (telemetry)** | Started + completed spans with body capture | ✅ URL, headers, duration via `diagnostics_channel`. Body capture in proxy sidecar (`OPENBOX_PROXY_BODY_CAPTURE=true`): req+res bodies buffered and emitted as span. | ✅ Done (proxy) | — |
| F10 | **HTTP Blocking (pre-call)** | Synchronous block before request goes on wire | Proxy sidecar only | ⚠️ Partial | ⚠️ Via proxy only — `diagnostics_channel` is async-observe-only. Inline sync blocking is impossible from hooks. Proxy is the correct solution for self-hosted. |
| F11 | **HTTP Traceparent injection** | W3C `traceparent` propagated across activities | ✅ `X-OpenBox-Session-Id` injected via `diagnostics_channel` at `http.client.request.start`; proxy parses it for `session_id`/`workflow_id` attribution | ✅ Done | — |
| F12 | **DB Governance (Postgres)** | Pre/post query hooks, can block | ✅ Observe always on. Blocking opt-in via `OPENBOX_HOOKS_DB_BLOCKING=true`; awaits `evaluate()` verdict before executing query, throws `GovernanceBlockedError` on block/halt. Fail-open/closed configurable. | ✅ Done | — |
| F13 | **DB Governance (MongoDB, Redis, MySQL)** | Full driver suite | Postgres only | ❌ Missing | ✅ Feasible for MongoDB, Redis via similar prototype patching. MySQL via `mysql2` prototype patch. Not urgent given n8n's primary DB nodes. |
| F14 | **File I/O Governance** | Patches `builtins.open()`, opt-in | Not implemented | ❌ Missing | ⚠️ Risky — patching Node.js `fs` module globally in a shared n8n process is unsafe. Could cause subtle breakage in n8n internals. Not recommended. |
| F15 | **`@traced` Decorator** | Inline function decorator creating OTel spans | Not applicable to no-code flows | ❌ N/A | 🔴 Not applicable — n8n Code node users could use it but there's no runtime hook for it. Not a priority for the n8n platform. |
| F16 | **Context Propagation** | OTel trace_id matches spans to `(workflow_id, activity_id)` | Heuristic: youngest active session gets the span | ⚠️ Partial | ✅ Partially feasible — improving via `X-OpenBox-Session-Id` header injection from nodes |
| F17 | **HITL Approval Polling** | Retryable activity; Temporal handles retry scheduling | Polling loop in node (`while/sleep`), holds execution slot | ⚠️ Partial | ✅ Feasible improvement — split pattern: Request node → wait → Trigger node resumes. Already documented in QUICKSTART. |
| F18 | **Local Expiration Check** | Parse `approval_expiration_time` from API response | ✅ `approval_expiration_time` (and `expires_at`) parsed from poll response; deadline tightened when server expiry is sooner than `maxWaitMs` | ✅ Done | — |
| F19 | **Credentials never in payloads** | API key only on `GovernanceActivities` instance | Credentials fetched via n8n's encrypted store, not in spans | ✅ Implemented | — |
| F20 | **Fail-open / fail-closed** | Configurable per-config | Configurable per credential (`failPolicy`) | ✅ Implemented | — |
| F21 | **Guardrails Integration** | Block even when verdict is `allow` if guardrails fail | Passed as verdict field; routing logic present | ✅ Implemented | — |
| F22 | **HTTPS enforcement** | Non-localhost must use HTTPS | `enforceHttps` toggle in credential | ✅ Implemented | — |
| F23 | **Webhook HMAC Signature** | Not in Python SDK (n8n-specific) | Implemented in `OpenBoxTrigger` with timing-safe comparison | ✅ Implemented | — |
| F24 | **Replay attack protection** | Not in Python SDK | `X-OpenBox-Timestamp` tolerance window in `OpenBoxTrigger` | ✅ Implemented | — |
| F25 | **Unit test coverage** | Each interceptor, hook type, HITL, abort flag | Vitest tests for all node helpers and credential normalization | ✅ Implemented | — |

---

## Feasibility Assessment — What Can Be Implemented

### ✅ Implementable Now (Low effort, n8n APIs confirm support)

#### ~~1. WorkflowFailed Error Extraction (`run.data.resultData.error`)~~ ✅ DONE
The `IRun` object exposed in `workflow.postExecute` contains the error at `run.data.resultData.error` (top-level) and per-node errors at `run.data.resultData.runData[nodeName][i].error`. Note `run.status` will be `'error'` for failed workflows and `'crashed'` for process crashes. Currently `openbox-hooks.js` sends only the status field.

**Fix:** In the `postExecute` handler, extract:
```javascript
const topError = run?.data?.resultData?.error;
const lastNode = run?.data?.resultData?.lastNodeExecuted;
const nodeError = lastNode && run?.data?.resultData?.runData?.[lastNode]?.[0]?.error;
const error = topError ?? nodeError;
const errorPayload = error ? {
  message: error.message,
  name: error.name,
  stack: error.stack ?? null,   // May be absent for network-origin errors
  node_name: lastNode ?? error.node ?? null,
  type: error.type,             // NodeOperationError / NodeApiError
} : undefined;
```

#### ~~2. API Key Format Validation + Startup Ping in Hooks (`n8n.ready`)~~ ✅ DONE
The `n8n.ready` hook receives `(server, config)`. The OpenBox API key is available from `process.env.OPENBOX_API_KEY`. A validation block can be added:
```javascript
n8n.ready: [async function(server, config) {
  const key = process.env.OPENBOX_API_KEY;
  if (!/^obx_(live|test)_/.test(key)) {
    log.warn('OPENBOX_API_KEY format invalid (expected obx_live_* or obx_test_*)');
  }
  // Optional: ping /api/v1/auth/validate
}]
```

#### ~~3. Approval Expiration from API Response~~ ✅ DONE
The `poll_approval` response already returns `approval_expiration_time`. The polling loop in `OpenBox.node.ts` should compare `Date.now()` against the parsed ISO timestamp and short-circuit.

#### 4. Native OpenTelemetry Support (`N8N_OTEL_ENABLED=true`)
**NEW — discovered during research.** Since n8n v2.19.0, self-hosted n8n has built-in OpenTelemetry support:
```bash
N8N_OTEL_ENABLED=true
N8N_OTEL_EXPORTER_OTLP_ENDPOINT=http://your-collector:4318
N8N_OTEL_TRACES_INCLUDE_NODE_SPANS=true
```
This automatically emits OTLP spans for workflow and node executions, and **auto-injects W3C `traceparent` headers** for the HTTP Request node (not other built-in nodes). It can reduce or replace some of the `diagnostics_channel` approach for platform-level tracing.

**Impact on the demo:** The demo can be extended to set `N8N_OTEL_ENABLED=true` and point to an OTLP-compatible collector (or OpenBox's own OTLP endpoint if supported). This gives node-execution span data without any custom hooks.

#### ~~5. Workflow CRUD Audit Hooks~~ ✅ DONE
The `workflow.beforeCreate`, `workflow.update`, `workflow.afterCreate`, and `workflow.afterDelete` hooks are now confirmed. These can emit governance events tracking when workflows are created, modified, or deleted — a compliance-relevant audit trail.

#### 6. Workflow Activate / Deactivate Telemetry (`workflow.activate`)
The `workflow.activate` hook fires before a workflow is enabled. This can emit a governance event (e.g., `WorkflowActivated`) to log when scheduled/trigger workflows come online. **Not in the original spec** but a natural n8n-specific enrichment.

#### 5. Tag Lifecycle Hooks (`tag.beforeCreate`, `tag.afterCreate`, etc.)
New — the `ExternalHooksMap` exposes full tag CRUD hooks. These can be used to emit governance events when workflow tags change (useful for compliance workflows that gate on tag presence).

#### ~~6. Credential Change Telemetry (`credentials.create/update/delete`)~~ ✅ DONE
The `credentials.*` hooks expose the encrypted credential record. OpenBox can be notified when an agent's credentials change. **Implemented in `openbox-hooks.js`.** Useful for audit trails.

---

### ⚠️ Partially Feasible (Complex, but achievable with caveats)

#### ~~7. HTTP Request/Response Body Capture~~ ✅ DONE
Implemented in the proxy sidecar (`OPENBOX_PROXY_BODY_CAPTURE=true`). When enabled, the proxy buffers the upstream response body (up to `OPENBOX_PROXY_BODY_CAP_BYTES`, default 64 KB) and emits a post-request span with both request and response body previews. HTTPS bodies remain inaccessible by design (TLS tunnel).

#### ~~8. Traceparent / Session Header Injection → Proxy~~ ✅ DONE
The `diagnostics_channel` `http.client.request.start` event exposes the `request` object. Headers **can** be added to `request` at this stage before the socket writes:
```javascript
dc.subscribe('http.client.request.start', ({ request }) => {
  const sessionId = findActiveSession();
  if (sessionId) request.setHeader('X-OpenBox-Session-Id', sessionId);
});
```
The proxy sidecar then parses `X-OpenBox-Session-Id` to attribute the request to the right workflow execution.

**Feasibility:** High — this is the recommended path for solving the proxy correlation gap (Gap #1 in the previous analysis).

#### ~~9. Pre-execution DB Blocking (Postgres)~~ ✅ DONE
Opt-in via `OPENBOX_HOOKS_DB_BLOCKING=true`. The pg patch now awaits `evaluateQuery()` before calling the real `query()`. Internal n8n queries (database name matches `/n8n/i`) are always skipped. Fail policy configurable via `OPENBOX_HOOKS_DB_FAIL_OPEN`. Self-hosted only.

---

### 🔴 Not Feasible (Platform constraints confirmed)

#### 10. Per-Node Interception (GAP-6 confirmed)
Confirmed via n8n `ExternalHooksMap` source: **no `node.preExecute` or `node.postExecute`** hook exists. The only workaround is explicit OpenBox checkpoint nodes in the workflow design.

#### 11. Execution Termination from Hooks (GAP-8 confirmed)
The n8n REST API has `DELETE /api/v1/executions/:id` to cancel an execution, but:
- The execution ID is not available during `workflow.preExecute` (it hasn't been assigned yet).
- Calling the REST API from within a hook is self-referential and creates a race condition.
- Confirmed: **no internal `cancelExecution()` API is exposed to hook functions**.

The only clean path is a sidecar that watches for HALT verdicts and calls the n8n API from the outside.

#### 12. File I/O Governance
Patching the global `fs` module in Node.js is unsafe in a shared process like n8n. n8n itself uses `fs` extensively for internal operations (reading workflow files, loading custom nodes, etc.). A governance patch would need to scope itself to execution-context file operations with no reliable way to distinguish them from n8n's own operations.

#### 13. n8n Cloud Support
`EXTERNAL_HOOK_FILES` is **self-hosted only**. The hooks module, proxy sidecar, and all Phase 2/3 features are unavailable on n8n Cloud. Only the custom node package (Phase 1) works on n8n Cloud.

---

## Newly Discovered Gaps (Not in Previous Analysis)

### NEW-1: Queue-Mode Hook Blackout (CRITICAL for production scale)
`EXTERNAL_HOOK_FILES` is loaded only on the n8n **main** process. In `N8N_MODE=queue` (separate worker pods), worker processes that actually execute workflows do NOT load external hooks. `workflow.preExecute` and `workflow.postExecute` will silently not fire for any workflow executed by a worker.

**Impact:** High — all observability (spans, WorkflowStarted/Completed events) is lost in queue-mode deployments.
**Fix options:**
1. Pin governance to the main process only and accept the gap (simplest).
2. For each worker, set `EXTERNAL_HOOK_FILES` in the worker container env too. The `worker.ready` hook fires on workers and can be used to re-init the hooks.
3. Use `N8N_OTEL_ENABLED=true` for worker-safe tracing (OTel spans work across all processes).

### ~~NEW-2: `activeWorkflows.initialized` Hook — Missed Opportunity~~ ✅ DONE
This hook fires after all active (scheduled/trigger) workflows have been polled from the database and reactivated. Emits a `WorkflowsReactivated` governance event on startup.

**Impact:** Low — nice-to-have observability.

### ~~NEW-3: `workflow.afterCreate` / `workflow.afterUpdate` / `workflow.afterDelete` — Audit Trail~~ ✅ DONE
These three hooks fire on workflow CRUD operations. Now emit `WorkflowCreating`, `WorkflowCreated`, `WorkflowUpdated`, and `WorkflowDeleted` governance events.

**Impact:** Medium — required for full audit compliance.

### ~~NEW-4: Proxy Sidecar Has No Health Endpoint~~ ✅ DONE
The `openbox-proxy` Docker service has no `healthcheck` in `docker-compose.yml` (unlike `postgres` which has one). If the proxy crashes silently, n8n continues sending requests directly (bypassing governance) without any alert.

**Fix:** Added `GET /health` endpoint to proxy server and Docker `healthcheck` directive in `docker-compose.yml`.

### NEW-5: `n8n-import` Credential Template Leaks Plaintext Key
The `seed.sh` writes the agent API key to a Docker volume file (`/seed/agent_key`). The `n8n-import` service reads this file, substitutes it into `openbox.template.json`, and writes `openbox.json`. The materialized `openbox.json` file sits **unencrypted in a volume**. n8n will encrypt it on import, but the intermediate file is plaintext at rest until import completes.

**Impact:** Low for dev, potentially medium for staging.
**Fix:** Write the key directly to n8n via the n8n REST API (`POST /api/v1/credentials`) rather than using file-based import.

### ~~NEW-6: QUICKSTART.md References Windows Path~~ ✅ DONE
Line 19 of `QUICKSTART.md` contained a Windows-style `cd "c:\Office work\openbox-sdk\example\n8n"` command. Fixed to `cd example/n8n`.

### ~~NEW-7: Hooks Module Has No Circuit Breaker~~ ✅ DONE (pre-existing)
`openbox-hooks-transport.js` drops spans silently when OpenBox Core is unreachable. However, there is no circuit-breaker pattern — every span still attempts a full HTTP round-trip before timing out at 5 seconds. Under sustained Core unavailability, this means every workflow execution incurs a 5-second delay per span per concurrent request (bounded by `MAX_INFLIGHT=10`).

**Impact:** Medium — performance degradation under Core outages.
**Fix:** Add a simple circuit-breaker: after N consecutive failures, switch to fail-fast mode for a cooldown period (e.g., 30 seconds) before retrying.

### ~~NEW-8: Missing `n8n.stop` Hook — No Graceful Shutdown~~ ✅ DONE
The `n8n.stop` hook fires when the n8n process is shutting down. The hooks module does not register it. On shutdown, any in-flight spans (`pendingHttpSpans` WeakMap entries) are lost silently with no drain.

**Fix:** `n8n.stop` now calls `drainAndFlush()` to wait for in-flight spans before exit.

### NEW-9: Hook State Is Not Persistent Across Worker Restarts
The `sessions` Map and `abortedExecutions` Set are module-level in-memory state (`openbox-hooks-state.js`). If n8n restarts mid-execution (or if n8n is run in queue mode with multiple workers), session correlation is lost. Any `workflow.postExecute` hook that fires after a restart will find no matching session in the Map and silently skip span emission.

**Impact:** Medium — data loss on restart; low risk for single-process deployments.
**Fix:** For production, consider externalizing session state to Redis or n8n's Postgres.

### NEW-10: Custom Node Version Not Pinned + Missing npm Provenance
`docker-compose.yml` builds the custom node from the local source (`context: ../..`). There is no versioned npm package or tagged image.

Additionally: **as of May 1, 2026**, n8n's community node verification program requires packages to be published via a **GitHub Actions OIDC Trusted Publisher** with npm provenance statements. Packages without provenance are still installable but won't receive the "Verified" badge in the n8n community node panel.

**Fix:** Publish `n8n-nodes-openbox-hook` to npm with a GitHub Actions workflow using OIDC (the `npm publish --provenance` flag). Reference a specific pinned version in the Dockerfile.

---

## Recommended Implementation Priorities

### Phase 2.1 — Quick Wins (All ✅ Feasible)

| # | Change | File | Effort |
|---|---|---|---|
| 1 | ~~Extract error detail in `WorkflowFailed`~~ | `hooks/openbox-hooks.js` | ✅ Done |
| 2 | ~~Add API key format check in `n8n.ready`~~ | `hooks/openbox-hooks.js` | ✅ Done |
| 3 | ~~Parse `approval_expiration_time` in polling loop~~ | `custom-node/src/nodes/OpenBox/OpenBox.node.ts` | ✅ Done |
| 4 | ~~Wire `n8n.stop` for graceful span drain~~ | `hooks/openbox-hooks.js` | ✅ Done |
| 5 | ~~Wire `worker.ready` same as `n8n.ready`~~ | `hooks/openbox-hooks.js` | ✅ Done |
| 6 | ~~Fix QUICKSTART.md Windows path~~ | `QUICKSTART.md` | ✅ Done |

### Phase 2.2 — Medium Wins

| # | Change | File | Effort |
|---|---|---|---|
| 7 | ~~Inject `X-OpenBox-Session-Id` in `diagnostics_channel` hook~~ | `hooks/openbox-hooks-http.js` | ✅ Done |
| 8 | ~~Parse `X-OpenBox-Session-Id` in proxy for attribution~~ | `openbox-proxy/src/server.js` | ✅ Done |
| 9 | ~~Add circuit breaker to span transport~~ | `hooks/openbox-hooks-transport.js` | ✅ Done (pre-existing) |
| 10 | ~~Add `credentials.*` / `workflow.afterCreate/update/beforeCreate` audit hooks~~ | `hooks/openbox-hooks.js` | ✅ Done |
| 11 | ~~Add proxy health endpoint + Docker healthcheck~~ | `openbox-proxy/`, `docker-compose.yml` | ✅ Done |
| 12 | ~~Enable `N8N_OTEL_ENABLED=true` + OTLP endpoint in docker-compose~~ | `docker-compose.yml` | ✅ Done |

### Phase 3 — Body Capture

| # | Change | File | Effort |
|---|---|---|---|
| 12 | ~~Capture request/response bodies in proxy sidecar~~ | `openbox-proxy/src/server.js` | ✅ Done |
| 13 | ~~Add pre-query governance blocking to pg patch~~ | `hooks/openbox-hooks-db.js` | ✅ Done |

### Documented Non-Goals (🔴 Not Feasible on n8n)

- Per-node automatic interception (requires forking n8n)
- Execution termination from within hooks (requires external sidecar calling the n8n REST API)
- `@traced` decorator for Code nodes
- `EXTERNAL_HOOK_FILES` support on n8n Cloud (use log streaming API instead — Enterprise tier)
- File I/O governance (unsafe to patch `fs` globally)
- Full observability in `N8N_MODE=queue` via hooks alone (OTel is the supported alternative)
