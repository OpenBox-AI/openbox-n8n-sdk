# OpenBox Temporal SDK — Design Reference

This document describes how the OpenBox Python SDK should work, what "ideal" looks like at every layer, and how each component fits together. It is the authoritative reference for contributors and for teams building new platform SDK equivalents.

---

## Contents

1. [What the SDK Does](#1-what-the-sdk-does)
2. [Architecture Overview](#2-architecture-overview)
3. [Integration Patterns](#3-integration-patterns)
4. [Verdict System](#4-verdict-system)
5. [Event Model](#5-event-model)
6. [Hook-Level Governance](#6-hook-level-governance)
7. [Human-in-the-Loop (HITL)](#7-human-in-the-loop-hitl)
8. [Component Reference](#8-component-reference)
9. [Configuration](#9-configuration)
10. [Error Handling & Error Types](#10-error-handling--error-types)
11. [Temporal Sandbox Constraints](#11-temporal-sandbox-constraints)
12. [Security Invariants](#12-security-invariants)
13. [Observability & Tracing](#13-observability--tracing)
14. [Ideal SDK Checklist](#14-ideal-sdk-checklist)

---

## 1. What the SDK Does

The OpenBox SDK wraps a Temporal worker to add three capabilities:

**Governance** — Every workflow event and activity execution is evaluated by the OpenBox Core API in real time. The API returns a verdict (`allow`, `constrain`, `require_approval`, `block`, `halt`) that the SDK enforces before the operation proceeds.

**Observability** — Every HTTP request, database query, file operation, and `@traced` function call within an activity is captured as a structured span and sent to the OpenBox API. No code changes inside activities are required.

**Human-in-the-Loop (HITL)** — When the API returns `require_approval`, the SDK pauses execution via Temporal's retry mechanism, polls for a human decision, and resumes or rejects accordingly.

The SDK does not change workflow determinism requirements. All non-deterministic work (HTTP calls to OpenBox, approval polling) happens inside activities, never inside workflow code.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Temporal Worker                                                      │
│                                                                       │
│  ┌─────────────────────────────┐  ┌──────────────────────────────┐  │
│  │  WorkflowInboundInterceptor │  │  ActivityInboundInterceptor  │  │
│  │  (GovernanceInterceptor)    │  │  (ActivityGovernanceIntercep)│  │
│  │                             │  │                              │  │
│  │  • WorkflowStarted          │  │  • ActivityStarted           │  │
│  │  • WorkflowCompleted        │  │  • ActivityCompleted         │  │
│  │  • WorkflowFailed           │  │  • Verdict enforcement       │  │
│  │  • SignalReceived            │  │  • HITL approval polling     │  │
│  └─────────────┬───────────────┘  └──────────────┬───────────────┘  │
│                │ via execute_activity             │ via GovernanceClient│
│                ▼                                  ▼                   │
│  ┌─────────────────────────────┐  ┌──────────────────────────────┐  │
│  │  GovernanceActivities       │  │  Hook-Level Governance       │  │
│  │  send_governance_event()    │  │  (OTel instrumentation)      │  │
│  │                             │  │  • HTTP (httpx, requests...) │  │
│  │  Credentials live here,     │  │  • Database (psycopg2, mongo)│  │
│  │  never in event payloads    │  │  • File I/O                  │  │
│  └─────────────┬───────────────┘  │  • @traced functions         │  │
│                │                  └──────────────┬───────────────┘  │
└────────────────┼─────────────────────────────────┼──────────────────┘
                 │                                  │
                 ▼                                  ▼
          POST /api/v1/governance/evaluate  (OpenBox Core API)
          ← GovernanceVerdictResponse (verdict, reason, guardrails_result, ...)
```

### WorkflowSpanProcessor — the connective tissue

A single `WorkflowSpanProcessor` instance is created when the worker starts and passed to both interceptors and to the hook-level governance module. It holds:

- **Activity context** — workflow_id, run_id, activity_id, activity_type keyed by OTel trace_id. This lets hook-level governance attach the correct workflow and activity identifiers to every span payload without any thread-local state.
- **Pending verdicts** — when a signal governance call returns `block` or `halt`, the interceptor stores the verdict here so the next activity execution picks it up and enforces it.
- **Activity abort flags** — once any hook blocks or halts within an activity, subsequent hooks short-circuit without hitting the API again.
- **Halt requests** — when a hook verdict is `halt`, the flag is set here so the activity interceptor can call `client.terminate()` on the workflow.

The span processor also satisfies the OTel `SpanProcessor` interface (forwarding spans to an optional exporter) but its primary role is governance state management.

---

## 3. Integration Patterns

There are three supported patterns in descending order of preference.

### Pattern A — Plugin (Temporal ≥ 1.23, recommended)

```python
from temporalio.worker import Worker
from openbox.plugin import OpenBoxPlugin

worker = Worker(
    client,
    task_queue="my-queue",
    workflows=[MyWorkflow],
    activities=[my_activity],
    plugins=[
        OpenBoxPlugin(
            openbox_url="https://api.openbox.ai",
            openbox_api_key="obx_live_xxx",
        )
    ],
)
await worker.run()
```

`OpenBoxPlugin` is a `SimplePlugin`. It receives the `WorkerConfig` before the worker starts, injects interceptors and the governance activity, and configures OTel instrumentation. This is the canonical approach because:

- It wires itself cleanly into the worker's lifecycle.
- The Temporal client reference (needed for `HALT` terminations) is available through `configure_worker`.
- It requires no changes to the workflows or activities themselves.

### Pattern B — Factory Function (all Temporal versions)

```python
from openbox import create_openbox_worker

worker = create_openbox_worker(
    client=client,
    task_queue="my-queue",
    workflows=[MyWorkflow],
    activities=[my_activity],
    openbox_url="https://api.openbox.ai",
    openbox_api_key="obx_live_xxx",
)
await worker.run()
```

`create_openbox_worker` performs the same setup as the plugin but as a plain function. All standard `Worker` constructor parameters are forwarded.

### Pattern C — Manual Assembly (advanced)

For teams integrating individual components into an existing OTel setup:

```python
from openbox import (
    initialize, GovernanceConfig,
    WorkflowSpanProcessor, GovernanceInterceptor, ActivityGovernanceInterceptor,
)
from openbox.otel_setup import setup_opentelemetry_for_governance
from openbox.activities import build_governance_activities

initialize(api_url=..., api_key=...)

span_processor = WorkflowSpanProcessor(exporter=your_exporter)
setup_opentelemetry_for_governance(
    span_processor=span_processor,
    api_url=..., api_key=...,
    ignored_urls={"https://api.openbox.ai"},
    instrument_databases=True,
)

config = GovernanceConfig(...)
governance_activities = build_governance_activities(api_url, api_key)

worker = Worker(
    client, task_queue="...",
    workflows=[...], activities=[..., governance_activities.send_governance_event],
    interceptors=[
        GovernanceInterceptor(api_url, api_key, span_processor, config),
        ActivityGovernanceInterceptor(api_url, api_key, span_processor, config, client),
    ],
    workflow_runner=SandboxedWorkflowRunner(
        restrictions=SandboxRestrictions.default.with_passthrough_modules("opentelemetry")
    ),
)
```

---

## 4. Verdict System

Every evaluation call to the OpenBox Core API returns exactly one verdict. The SDK enforces a strict priority order when aggregating verdicts from multiple evaluations within the same activity.

### Verdicts (priority high → low)

| Verdict | Priority | SDK action |
|---|---|---|
| `halt` | 5 | Terminate the entire workflow. Non-retryable. Calls `client.terminate()` on the Temporal workflow and raises `GovernanceHaltError`. |
| `block` | 4 | Fail the activity permanently. Non-retryable `ApplicationError`. Raises `GovernanceBlockedError`. |
| `require_approval` | 3 | Pause execution. Raise a retryable `ApplicationError`. On retry, poll the API for a human decision. |
| `constrain` | 2 | Log the constraint, continue. No interruption to execution. |
| `allow` | 1 | Continue normally. |

### Verdict type: `Verdict`

```python
class Verdict(str, Enum):
    ALLOW = "allow"
    CONSTRAIN = "constrain"
    REQUIRE_APPROVAL = "require_approval"
    BLOCK = "block"
    HALT = "halt"

    @property
    def priority(self) -> int: ...

    def should_stop(self) -> bool:
        """True for BLOCK and HALT."""
```

### Ideal verdict enforcement

1. A single `enforce_verdict()` function handles all five cases. No verdict logic lives in interceptors — they call `enforce_verdict` and react to the return value or exceptions.
2. `HALT` always precedes `BLOCK`. If a `HALT` verdict is received, the workflow is terminated before raising any error.
3. Guardrails results are checked after `BLOCK` and before `REQUIRE_APPROVAL`. A failed guardrails check is treated as a block even if the verdict field itself is `allow`.
4. `CONSTRAIN` only logs — it must not disrupt execution in any way.

---

## 5. Event Model

### Event types

| Event | Trigger | Where sent |
|---|---|---|
| `WorkflowStarted` | Before workflow body executes | Via `send_governance_event` activity |
| `WorkflowCompleted` | Workflow returns successfully | Via `send_governance_event` activity |
| `WorkflowFailed` | Workflow raises an exception | Via `send_governance_event` activity (exception is re-raised after) |
| `SignalReceived` | Signal handler executes | Via `send_governance_event` activity |
| `ActivityStarted` | Before activity body executes | Via `GovernanceClient.evaluate_event()` directly |
| `ActivityCompleted` | Activity returns (or raises) | Via `GovernanceClient.evaluate_event()` directly |

### Why the asymmetry?

Workflow-level events (`WorkflowStarted`, `WorkflowCompleted`, `WorkflowFailed`, `SignalReceived`) are sent via a dedicated governance activity because workflow code runs inside Temporal's deterministic sandbox. HTTP calls are not allowed from workflow code. The pattern is:

```python
await workflow.execute_activity(
    "send_governance_event",
    {"payload": event_payload, "timeout": 30.0, "on_api_error": "fail_open"},
    schedule_to_close_timeout=timedelta(seconds=60),
)
```

Activity-level events are sent directly from the activity interceptor using `GovernanceClient` because activities run outside the sandbox.

### What an event payload contains

**WorkflowStarted / WorkflowCompleted / WorkflowFailed**
- `event_type`, `workflow_id`, `run_id`, `workflow_type`, `task_queue`
- `workflow_output` (completed), `error` + cause chain (failed)
- `timestamp` added in activity context (non-deterministic, cannot be set in workflow code)

**SignalReceived**
- `event_type`, `workflow_id`, `run_id`, `signal_name`, `signal_args`

**ActivityStarted**
- `event_type`, `workflow_id`, `run_id`, `activity_id`, `activity_type`, `task_queue`
- `activity_input`, `attempt`

**ActivityCompleted**
- All ActivityStarted fields
- `activity_output`, `status` (`success` or `failure`), `duration_ms`
- `spans` — hook-level governance spans collected during this activity

### Credentials in event payloads

Credentials (API key, URL) must never appear in event payloads or activity inputs. They belong on the `GovernanceActivities` instance. This is the one invariant that cannot be compromised — activity inputs are visible in Temporal's workflow history.

---

## 6. Hook-Level Governance

Hook-level governance evaluates individual operations — HTTP requests, database queries, file operations, and decorated functions — at both the `started` (pre-operation) and `completed` (post-operation) stages.

### How it works

OTel instrumentation is installed when the worker starts. The instrumented libraries (httpx, requests, psycopg2, etc.) fire hooks before and after each operation. Those hooks call `hook_governance.evaluate_sync()` or `evaluate_async()`, which:

1. Looks up the current activity context from `WorkflowSpanProcessor` using the OTel trace_id.
2. Checks the activity abort flag. If set, short-circuits without hitting the API.
3. Builds a payload combining activity context + operation span data + `hook_trigger: true`.
4. POSTs to `/api/v1/governance/evaluate`.
5. On `BLOCK` or `HALT`: raises `GovernanceBlockedError`, sets the activity abort flag.
6. On `REQUIRE_APPROVAL`: sets the activity abort flag, raises.
7. On `ALLOW`/`CONSTRAIN`: returns.

### The abort flag

The abort flag is critical for efficiency and consistency. Once any hook within an activity returns a blocking verdict, the abort flag is set for that `(workflow_id, activity_id)` pair. All subsequent hooks in the same activity check this flag first and return immediately without an API call. This prevents:

- Duplicate evaluations after a block decision.
- Accumulation of latency from evaluating every remaining operation after one is already blocked.

The abort flag is cleared when the activity interceptor unregisters the activity context (after `ActivityCompleted` is sent).

### Supported instrumentation targets

| Category | Libraries | Hook stage support |
|---|---|---|
| HTTP | httpx, requests, urllib3, urllib | started + completed |
| Database | psycopg2, asyncpg, pymysql, mysql-connector | started + completed (via OTel CursorTracer patch) |
| Database | pymongo | started (best-effort) + completed |
| Database | redis | started + completed (via OTel request_hook / response_hook) |
| Database | SQLAlchemy | started + completed (via engine event listeners) |
| File I/O | Python builtins (`open`) | per-operation started + completed, close lifecycle summary |
| Functions | `@traced` decorator | started + completed |

### HTTP body capture

HTTP request and response bodies are captured for text content types (JSON, XML, HTML, form data). Binary content (images, audio, archives) is skipped. The default cap is 64 KB per body (`max_body_size=65536`). Bodies larger than the cap are truncated with a marker.

### Database instrumentation variants

**DBAPI-compatible drivers** (psycopg2, asyncpg, pymysql): The OTel `CursorTracer.traced_execution()` method is patched directly. This gives clean `started`/`completed` pairs for every query with full SQL statement capture.

**pymongo**: Uses a `CommandListener` for operation events plus a `wrapt`-based collection wrapper for context. This is best-effort — some MongoDB commands only expose the `completed` stage. Thread-local state prevents duplicate evaluations.

**Redis**: Uses OTel's native `request_hook` / `response_hook` integration.

**SQLAlchemy**: Installs `before_cursor_execute` and `after_cursor_execute` event listeners. If a pre-existing engine is provided, it is instrumented directly. Otherwise, future `create_engine()` calls are patched.

### File I/O instrumentation

File I/O is opt-in (`instrument_file_io=True`) because patching `builtins.open()` has broad scope. When enabled, `TracedFile` wraps the returned file object and creates a span + governance evaluation for every `open`, `read`, `readline`, `readlines`, `write`, `writelines`, and `close` call.

The `close` evaluation includes a lifecycle summary: total `bytes_read`, `bytes_written`, and ordered `operations` list. System paths (`/dev/`, `/proc/`, `/sys/`, `__pycache__`) are skipped automatically to avoid noise.

### `@traced` decorator

The `@traced` decorator creates an OTel span and optionally submits governance evaluations for any Python function:

```python
@traced
def infer(prompt: str) -> str: ...

@traced(name="infer", capture_args=True, capture_result=True, capture_exception=True)
async def infer(prompt: str) -> str: ...
```

Options:

| Option | Default | Effect |
|---|---|---|
| `name` | function name | Override the span name |
| `capture_args` | `False` | Include function arguments in `started` payload |
| `capture_result` | `False` | Include return value in `completed` payload |
| `capture_exception` | `True` | Include exception info in `completed` payload |

When hook-level governance is not configured, `@traced` still creates OTel spans at zero evaluation overhead.

---

## 7. Human-in-the-Loop (HITL)

HITL is the mechanism for pausing execution while a human reviews an operation.

### Flow

```
ActivityStarted evaluation → verdict: require_approval
        ↓
Activity interceptor sets buffer.pending_approval = True
        ↓
Raises retryable ApplicationError(type="ApprovalPending")
        ↓
Temporal schedules activity retry
        ↓
On retry: activity interceptor checks pending_approval flag
        ↓
Calls GovernanceClient.poll_approval(workflow_id, run_id, activity_id)
        ↓
API response:
  • Still pending → raise ApprovalPending again (keep retrying)
  • verdict: allow → clear flag, proceed
  • Expired       → raise non-retryable ApprovalExpiredError
  • Rejected      → raise non-retryable ApprovalRejectedError
```

### HITL from hook-level governance

When a hook evaluation returns `require_approval`, the abort flag is set and `ApprovalPending` is raised from within the activity body. The activity interceptor catches this on the way out, sets `pending_approval`, and re-raises. From Temporal's perspective this is a normal retryable activity failure.

### Disabling HITL

Set `hitl_enabled=False` in `GovernanceConfig` or `OpenBoxPlugin` to treat `require_approval` verdicts as `block`. Useful in fully automated pipelines where human intervention is not available.

Per-activity HITL bypass is supported via `skip_hitl_activity_types`.

---

## 8. Component Reference

### `openbox/types.py`

Sandbox-safe data models. Can be imported from workflow code without triggering sandbox violations.

**`Verdict`** — the five-value enum with `.priority` and `.should_stop()`.

**`WorkflowEventType`** — six-value enum of event names.

**`WorkflowSpanBuffer`** — per-workflow governance state: `workflow_id`, `run_id`, `workflow_type`, `task_queue`, `verdict` (from signal governance), `pending_approval`.

**`GovernanceVerdictResponse`** — parsed API response: `verdict`, `reason`, `policy_id`, `risk_score`, `approval_id`, `guardrails_result`.

**`GuardrailsCheckResult`** — guardrails output: `redacted_input`, `input_type` (`activity_input` or `activity_output`), `validation_passed`, `reasons`.

### `openbox/config.py`

**`GovernanceConfig`** — immutable configuration passed to both interceptors. Controls which events are sent, which workflow/activity/signal types to skip, API error policy, timeouts, body size limit, and HITL settings.

**`initialize(api_url, api_key, ...)`** — validates the API key format (`obx_live_*` or `obx_test_*`), checks URL security, and verifies server connectivity via `GET /api/v1/auth/validate`. Must be called before any worker starts.

**`get_global_config()`** — returns the validated URL and API key after `initialize`.

### `openbox/span_processor.py`

**`WorkflowSpanProcessor`** — central governance state store. Thread-safe. Implements the OTel `SpanProcessor` interface for span forwarding but its primary role is state management.

Key groups:

- **Workflow buffers**: `register_workflow`, `get_buffer`, `unregister_workflow`
- **Verdicts** (signal governance → activity interceptor): `set_verdict`, `get_verdict`, `clear_verdict`
- **Activity context** (interceptor → hooks): `set_activity_context`, `get_activity_context_by_trace`, `clear_activity_context`
- **Abort flags** (hooks → hooks): `set_activity_abort`, `get_activity_abort`
- **Halt requests** (hooks → activity interceptor): `set_halt_requested`, `get_halt_requested`

### `openbox/client.py`

**`GovernanceClient`** — async HTTP client for activity-level governance calls.

- `evaluate_event(payload)` → `GovernanceVerdictResponse | None`  
  POSTs to `/api/v1/governance/evaluate`. Returns `None` on failure if `fail_open`, returns a `HALT` verdict if `fail_closed`.
- `poll_approval(workflow_id, run_id, activity_id)` → `dict | None`  
  POSTs to `/api/v1/governance/approval`. Checks `approval_expiration_time` locally before returning.

Uses a persistent `httpx.AsyncClient` created with double-checked locking to avoid connection pool exhaustion.

### `openbox/workflow_interceptor.py`

**`GovernanceInterceptor`** — `Interceptor` factory that returns `_Inbound`, a `WorkflowInboundInterceptor`.

`_Inbound.execute_workflow()`:
1. Send `WorkflowStarted` (unless `send_start_event=False` or type is skipped).
2. Execute workflow.
3. Send `WorkflowCompleted` on success.
4. On exception: send `WorkflowFailed` (without shadowing original exception), re-raise.

`_Inbound.handle_signal()`:
1. Send `SignalReceived`.
2. If verdict `.should_stop()`: store in span processor for next activity.
3. Handle signal normally.

### `openbox/activity_interceptor.py`

**`ActivityGovernanceInterceptor`** — `Interceptor` factory that returns `_ActivityInterceptor`.

`_ActivityInterceptor.execute_activity()` sequence:

1. Check for blocking verdicts from prior signal governance.
2. Check `pending_approval` flag for HITL retry.
3. Register activity context in span processor.
4. Send `ActivityStarted` event.
5. Enforce `ActivityStarted` verdict.
6. Apply input guardrails redaction if present.
7. Execute activity body.
8. Send `ActivityCompleted` event.
9. Enforce `ActivityCompleted` verdict.
10. Apply output guardrails redaction if present.
11. Unregister activity context, clear abort flag.

Exception handling:

- `GovernanceBlockedError` from hooks → wrap as non-retryable `ApplicationError(type="GovernanceBlock")`.
- `GovernanceHaltError` from hooks → call `client.terminate()` + raise.
- `GuardrailsValidationError` → non-retryable error.
- Any other exception → send `ActivityCompleted` with `status: failure`, re-raise.

### `openbox/hook_governance.py`

The central evaluator called by all hook types. Stateless from the caller's perspective — all state reads/writes go through the injected span processor.

Module-level setup via `configure(api_url, api_key, span_processor, ...)`. Persistent sync and async `httpx` clients managed with double-checked locking.

### `openbox/activities.py`

**`GovernanceActivities`** — holds credentials. Exposes one activity:

`send_governance_event(input: dict)` — `input` carries only `{"payload": {...}, "timeout": float, "on_api_error": str}`. Adds `timestamp` in activity context (safe: non-deterministic). POSTs to the evaluate endpoint. On `HALT` verdict, calls `_terminate_workflow_for_halt()` before raising.

Credentials are never in `input` — they live on `self`.

### `openbox/verdict_handler.py`

**`enforce_verdict(response, context)`** — single function for all verdict enforcement. Priority order: `HALT` → `BLOCK` → guardrails failure → `REQUIRE_APPROVAL` → `CONSTRAIN` → `ALLOW`. Returns `VerdictEnforcementResult(requires_hitl=True)` for `REQUIRE_APPROVAL`; raises for `HALT`, `BLOCK`, guardrails failure.

### `openbox/hitl.py`

**`handle_approval_response(response, ...)`** — processes a poll response. Returns `True` if approved, raises on expiry or rejection, raises retryable `ApprovalPending` if still waiting.

**`raise_approval_pending(reason)`** — raises `ApplicationError(non_retryable=False)` with `type="ApprovalPending"`.

### `openbox/errors.py`

Exception hierarchy (mirrors LangGraph SDK conventions):

```
OpenBoxError
├── OpenBoxConfigError
│   ├── OpenBoxAuthError
│   ├── OpenBoxNetworkError
│   └── OpenBoxInsecureURLError
├── GovernanceBlockedError
├── GovernanceHaltError
├── GovernanceAPIError
├── GuardrailsValidationError
├── ApprovalExpiredError
├── ApprovalRejectedError
└── ApprovalTimeoutError
```

`ApplicationError` type constants for Temporal routing:
- `GOVERNANCE_HALT_ERROR_TYPE = "GovernanceHalt"`
- `GOVERNANCE_BLOCK_ERROR_TYPE = "GovernanceBlock"`
- `GOVERNANCE_API_ERROR_TYPE = "GovernanceAPIError"`

`extract_governance_error(exc)` — walks the exception chain to recover a wrapped `GovernanceBlockedError` from inside a Temporal `ApplicationError`.

### `openbox/otel_setup.py`

**`setup_opentelemetry_for_governance(...)`** — the single entry point for all OTel setup. Called once when the worker starts.

Steps:
1. Calls `hook_governance.configure(...)`.
2. Installs HTTP instrumentors (httpx, requests, urllib3, urllib) with request/response hooks, ignoring the OpenBox API URL itself.
3. Installs database instrumentors based on `db_libraries` (defaults to all available).
4. Optionally installs file I/O instrumentation.
5. Registers the span processor with the global OTel tracer provider.

### `openbox/plugin.py`

**`OpenBoxPlugin(SimplePlugin)`** — drop-in plugin for Temporal ≥ 1.23.

Constructor performs the full setup sequence: validate → create span processor → setup OTel → create config → create interceptors → build governance activities → register sandbox passthrough for `opentelemetry`.

`configure_worker(config)` stores the Temporal client reference (needed for `HALT` terminate calls) and returns the modified config.

### `openbox/worker.py`

**`create_openbox_worker(...)`** — equivalent setup to the plugin, as a plain function. Accepts all standard `Worker` constructor parameters and forwards them.

### `openbox/tracing.py`

**`@traced`** — decorator usable on sync and async functions. Creates an OTel span; when hook governance is configured, evaluates the function at `started` and `completed` stages.

### `openbox/context_propagation.py`

**`ContextPropagatingExecutor`** — a `ThreadPoolExecutor` subclass that copies Python `ContextVar` state (including the OTel trace context) into executor threads. Install with `install_context_propagating_executor()` so that `loop.run_in_executor(None, fn)` calls inside activities preserve the trace context that hook governance needs to look up activity context.

---

## 9. Configuration

### `GovernanceConfig` fields

| Field | Type | Default | Purpose |
|---|---|---|---|
| `send_start_event` | bool | `True` | Send `WorkflowStarted` event |
| `send_activity_start_event` | bool | `True` | Send `ActivityStarted` event |
| `skip_workflow_types` | Set[str] | `set()` | Workflow types to skip entirely |
| `skip_activity_types` | Set[str] | `{"send_governance_event"}` | Activity types to skip (always include the governance activity itself) |
| `skip_signals` | Set[str] | `set()` | Signal names to skip |
| `on_api_error` | str | `"fail_open"` | `"fail_open"` (allow) or `"fail_closed"` (halt) |
| `api_timeout` | float | `30.0` | HTTP timeout for governance API calls |
| `max_body_size` | int | `65536` | Max HTTP body bytes to capture (64 KB) |
| `hitl_enabled` | bool | `True` | Enable HITL approval polling |
| `skip_hitl_activity_types` | Set[str] | `{"send_governance_event"}` | Activities where HITL is never triggered |

### `OpenBoxPlugin` / `create_openbox_worker` parameters

| Parameter | Purpose |
|---|---|
| `openbox_url` | Base URL of the OpenBox Core API |
| `openbox_api_key` | API key (`obx_live_*` or `obx_test_*`) |
| `governance_timeout` | API call timeout |
| `governance_policy` | `"fail_open"` or `"fail_closed"` |
| `send_start_event` | Toggle `WorkflowStarted` event |
| `send_activity_start_event` | Toggle `ActivityStarted` event |
| `skip_workflow_types` | Workflow types to exclude |
| `skip_activity_types` | Activity types to exclude |
| `skip_signals` | Signal names to exclude |
| `hitl_enabled` | Enable/disable HITL |
| `instrument_databases` | Enable database hook-level governance |
| `db_libraries` | Specific libraries to instrument (`None` = all detected) |
| `sqlalchemy_engine` | Pre-existing SQLAlchemy engine to instrument |
| `instrument_file_io` | Enable file I/O hook-level governance |
| `enable_trace_propagation` | Add W3C `TracingInterceptor` for cross-service trace propagation |

### URL & API key validation

Enforced at `initialize()` time and again in the plugin/factory constructor:

- API key must match `obx_live_*` or `obx_test_*`.
- Non-localhost URLs must use HTTPS. HTTP to a remote host raises `OpenBoxInsecureURLError`.
- The server must respond to `GET /api/v1/auth/validate` with a 200. Network failure raises `OpenBoxNetworkError`.

---

## 10. Error Handling & Error Types

### Retryable vs. non-retryable

All Temporal `ApplicationError` instances raised by the SDK specify retryability explicitly:

| Scenario | `non_retryable` | Type string |
|---|---|---|
| `BLOCK` verdict | `True` | `"GovernanceBlock"` |
| `HALT` verdict | `True` | `"GovernanceHalt"` |
| Guardrails failure | `True` | (from `GuardrailsValidationError`) |
| API failure, `fail_closed` | `True` | `"GovernanceAPIError"` |
| `REQUIRE_APPROVAL` (HITL waiting) | `False` | `"ApprovalPending"` |
| Approval expired | `True` | `"ApprovalExpired"` |
| Approval rejected | `True` | `"ApprovalRejected"` |

### `fail_open` vs `fail_closed`

`fail_open` (default): If the OpenBox API is unreachable or returns an error, the SDK allows execution to continue. Choose this for observability-first deployments where governance is not yet blocking.

`fail_closed`: If the API is unreachable, the SDK raises a non-retryable `GovernanceAPIError` and halts the workflow. Choose this for enforcement-first deployments where a governance outage should stop processing.

### `HALT` termination

`HALT` is special: the workflow must be terminated, not just failed. The sequence:

1. Activity raises `GovernanceHaltError`.
2. Activity interceptor catches it, calls `GovernanceClient.terminate(workflow_id)` on the Temporal client.
3. Raises `ApplicationError(type="GovernanceHalt", non_retryable=True)`.

The workflow is now terminated from the outside and also fails its current activity — two guarantees that it stops.

---

## 11. Temporal Sandbox Constraints

Temporal's deterministic workflow sandbox imposes restrictions that the SDK works around carefully.

### What the sandbox forbids

- Direct HTTP calls from workflow code (non-deterministic).
- Module-level imports that trigger filesystem access (`os.stat`, `logging.getLogger` at module scope).
- Any randomness, wall-clock reads, or I/O from within workflow functions.

### SDK responses to each constraint

**HTTP calls**: All HTTP calls to OpenBox are made from activities (`send_governance_event`) or from activity interceptors (`GovernanceClient`). Workflow code only calls `workflow.execute_activity()`.

**Module-level imports**: `openbox/__init__.py` never imports `httpx`, `opentelemetry`, or `logging` at module level. These are deferred to function bodies in modules that only run in activity or worker context.

**OTel passthrough**: OTel must be registered as a passthrough module in the worker's sandbox config. Both `OpenBoxPlugin` and `create_openbox_worker` do this automatically:

```python
SandboxedWorkflowRunner(
    restrictions=SandboxRestrictions.default.with_passthrough_modules("opentelemetry")
)
```

**Timestamps**: Event timestamps are not set in workflow code. They are set in the `send_governance_event` activity where `datetime.now()` is legal.

### What is safe to import in workflow files

The following are sandbox-safe:

```python
from openbox import Verdict, WorkflowSpanBuffer, GovernanceVerdictResponse
from openbox.types import WorkflowEventType
from openbox.errors import GovernanceBlockedError, GovernanceHaltError
```

The following are not safe in workflow files (they import httpx or OTel at module level):

```python
from openbox import create_openbox_worker   # needs httpx
from openbox.activities import GovernanceActivities  # needs httpx
from openbox.otel_setup import setup_opentelemetry_for_governance  # needs OTel
```

---

## 12. Security Invariants

These invariants must hold in any correct implementation of the SDK. Violating any of them creates either a security vulnerability or an operational failure.

### 1. Credentials never in event payloads or activity inputs

The API key is held on the `GovernanceActivities` instance (`self._api_key`). Activity inputs carry only the event payload, timeout, and error policy. This prevents credentials from appearing in Temporal's workflow history, which is visible to anyone with namespace read access.

### 2. HTTPS required for non-localhost

Sending an API key over plain HTTP to a remote host is a credential exposure risk. `OpenBoxInsecureURLError` is raised at initialization for any non-localhost URL that does not use HTTPS.

### 3. Abort flag prevents double-evaluation

After a block or halt verdict from any hook, the activity abort flag prevents subsequent hooks from making additional API calls. This is not merely an optimization — it prevents a racing hook from overwriting a halt decision with an allow.

### 4. Governance activity is always in the skip list

`send_governance_event` must appear in `skip_activity_types`. Governing the governance activity would create infinite recursion. The default `skip_activity_types` always includes it.

### 5. The OpenBox API URL is always in the ignored URL list for HTTP hooks

HTTP hook instrumentation must never evaluate calls made to the OpenBox API itself. Both the plugin and factory automatically add the `openbox_url` to the `ignored_urls` set passed to `setup_opentelemetry_for_governance`.

---

## 13. Observability & Tracing

### OpenTelemetry integration

The SDK integrates with OpenTelemetry as its instrumentation backbone. Every hook evaluation corresponds to an OTel span. Spans flow through `WorkflowSpanProcessor`, which forwards them to an optional downstream exporter (Jaeger, OTLP, etc.).

### W3C trace propagation

When `enable_trace_propagation=True` (default), the SDK adds Temporal's `TracingInterceptor` alongside the governance interceptors. This propagates W3C `traceparent` headers across workflow → activity boundaries and across service calls, enabling distributed traces in tools like Jaeger or Honeycomb.

### Context propagation in threads

Activities that call `loop.run_in_executor(None, fn)` execute `fn` in a thread pool. OTel trace context is carried by Python `ContextVar`s, which do not automatically cross thread boundaries. Install `ContextPropagatingExecutor` to copy the current context into every executor thread:

```python
from openbox.context_propagation import install_context_propagating_executor

# Called once at worker startup
install_context_propagating_executor(max_workers=32)
```

Without this, hook governance in threaded code cannot look up activity context and silently skips evaluation.

### Span payload structure

Every hook evaluation POSTed to the API includes:

```json
{
  "event_type": "ActivityStarted",
  "workflow_id": "...",
  "run_id": "...",
  "activity_id": "...",
  "activity_type": "...",
  "hook_trigger": true,
  "hook_type": "http_request",
  "hook_stage": "started",
  "method": "POST",
  "url": "https://api.example.com/v1/infer",
  "request_body": "...",
  "span_id": "...",
  "trace_id": "...",
  "parent_span_id": "..."
}
```

`hook_trigger: true` tells the API that this is an inline hook evaluation, not an activity lifecycle event.

---

## 14. Ideal SDK Checklist

Use this when auditing an implementation or building a new platform SDK (e.g., Node.js, Java).

### Setup & initialization

- [ ] `initialize()` validates API key format, URL security, and server connectivity before any worker starts.
- [ ] Non-localhost URLs without HTTPS raise an error immediately.
- [ ] The governance activity is always registered with the worker.
- [ ] The OpenBox API URL is always in the HTTP hook ignore list.
- [ ] OTel is registered as a passthrough in the workflow sandbox.
- [ ] `ContextPropagatingExecutor` is available and documented for threaded activity use.

### Event sending

- [ ] Workflow-level events are sent via `execute_activity` (never via HTTP from workflow code).
- [ ] Activity-level events are sent via direct HTTP from the activity interceptor.
- [ ] Timestamps are added in activity context, not in workflow code.
- [ ] Credentials are never in activity inputs or event payloads.
- [ ] `send_governance_event` is in the default `skip_activity_types` set.

### Verdict enforcement

- [ ] Enforcement priority: `HALT` > `BLOCK` > guardrails > `REQUIRE_APPROVAL` > `CONSTRAIN` > `ALLOW`.
- [ ] `HALT` calls `client.terminate()` before raising, and raises a non-retryable error.
- [ ] `BLOCK` raises a non-retryable `ApplicationError`.
- [ ] `REQUIRE_APPROVAL` raises a retryable `ApplicationError` and sets the HITL pending flag.
- [ ] `CONSTRAIN` only logs; it never interrupts execution.
- [ ] Guardrails failure blocks even when verdict is `allow`.

### Hook-level governance

- [ ] Every HTTP request is evaluated at `started` and `completed` stages.
- [ ] Every database query is evaluated at `started` (can block) and `completed` stages.
- [ ] File I/O is opt-in and defaults to off.
- [ ] `@traced` functions evaluate at `started` and `completed` when hook governance is configured; zero overhead otherwise.
- [ ] The abort flag is set after any blocking verdict.
- [ ] Subsequent hooks in the same activity check the abort flag before calling the API.
- [ ] The abort flag is cleared when the activity completes.
- [ ] Binary response bodies are not captured; only text content types.
- [ ] Body capture is capped at `max_body_size` (default 64 KB) with truncation marker.

### HITL

- [ ] `REQUIRE_APPROVAL` raises a retryable error (`ApprovalPending`).
- [ ] On retry, the pending flag is checked before the activity body runs.
- [ ] Approval polling uses a dedicated endpoint (`/api/v1/governance/approval`).
- [ ] Expiration is checked locally on the poll response (`approval_expiration_time`).
- [ ] Approved: clear flag, proceed.
- [ ] Expired or rejected: raise non-retryable error.
- [ ] `hitl_enabled=False` treats `require_approval` as `block`.

### Error model

- [ ] All `ApplicationError` instances declare `non_retryable` explicitly.
- [ ] Type strings (`"GovernanceBlock"`, `"GovernanceHalt"`, `"ApprovalPending"`) are constants, not magic strings.
- [ ] `extract_governance_error()` can unwrap a `GovernanceBlockedError` from inside a Temporal `ApplicationError`.

### Sandbox safety

- [ ] No `httpx`, `opentelemetry`, or `logging` imports at module level in `__init__.py`.
- [ ] Types that need to be imported from workflow code (`Verdict`, `WorkflowSpanBuffer`) have no OTel or httpx dependencies.
- [ ] The sandbox passthrough for `opentelemetry` is registered automatically; users do not need to do it manually.

### Security

- [ ] API key validated at startup (format + server ping).
- [ ] HTTP connections to remote OpenBox servers require HTTPS.
- [ ] Credentials never appear in workflow history (not in activity inputs, not in event payloads).
- [ ] The governance activity URL is excluded from hook-level HTTP governance evaluation.

### Tests

- [ ] Each interceptor (workflow, activity) has dedicated unit tests.
- [ ] Each hook type (HTTP, DB, file, @traced) has dedicated tests.
- [ ] HITL polling (pending, approved, expired, rejected) has dedicated tests.
- [ ] Abort flag propagation is tested (block from hook → subsequent hooks skip).
- [ ] Sandbox safety is verified with a Replayer integration test.
- [ ] `fail_open` and `fail_closed` paths are both tested.
- [ ] Credentials-never-in-inputs is verified by inspecting activity input structure in tests.
