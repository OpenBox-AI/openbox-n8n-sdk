# n8n-nodes-openbox-hook

OpenBox governance community node for n8n.

This package provides an **OpenBox: Agent** node that wraps n8n LangChain chat models, memory, and tools with OpenBox governance — policy evaluation, PII redaction, HITL approval, and audit traces — without changing your existing workflow structure.

## Install

In n8n, open **Settings > Community Nodes**, choose **Install**, and enter:

```
n8n-nodes-openbox-hook
```

Restart n8n if prompted.

## Credentials

Create an **OpenBox API** credential in n8n with:

| Field | Required | Description |
|---|---|---|
| **API Base URL** | Yes | OpenBox Core API base URL. Point it at your own deployment if self-hosting. |
| **API Key** | Yes | Your OpenBox API key. Live keys start with `obx_live_`; test keys with `obx_test_`. |
| **Agent DID** | No | Agent decentralised identifier (`did:aip:<uuid>`). Required only for agents with `signing_required = true`. |
| **Agent Private Key** | No | Base64-encoded raw 32-byte Ed25519 seed. Paired with Agent DID for signed requests. |
| **Workload Private Key** | No | The agent's workload identity key (RSA, PEM). When set, the node uses the OpenBox v3 API with a short-lived workload token. See [Workload identity (v3)](#workload-identity-v3). |

Get your API key from [dashboard.openbox.ai](https://dashboard.openbox.ai).

The credential test checks the whole chain: with a workload key it bootstraps
the agent's identity, obtains a workload token and validates it against Core.

## Usage

### Basic setup

1. Add an **OpenBox: Agent** node to your workflow.
2. Connect a **Chat Model** sub-node (e.g. OpenAI Chat Model, Anthropic Chat Model) to the **Chat Model** input.
3. Optionally connect **Memory** (max 1) and any number of **Tool** sub-nodes.
4. Attach your **OpenBox API** credential to the node.

That is the whole required setup — there is no agent name or task queue to fill
in. The node exposes the same inputs and outputs as the standard n8n AI Agent
node, so it is a drop-in replacement.

The agent identity reported to OpenBox is derived from the node itself:

- **agent name** — `n8n.Agent.<Node_Name>`, with spaces replaced by underscores. Renaming the node in the canvas renames the agent in your traces.
- **task queue** — always `n8n`.

### Example workflow

```
[Chat Trigger]
      │
      ▼
[OpenBox: Agent]  ←──  [OpenAI Chat Model]
      │            ←──  [Window Buffer Memory]
      │            ←──  [Calculator Tool]
      ▼
[Set node / downstream steps]
```

When the agent runs, OpenBox evaluates each LLM call and tool invocation
against your configured policies. If a call requires approval (HITL), the node
pauses and polls until a decision is received.

### Fallback model

Enable **Enable Fallback Model** to expose a second **Fallback Model** input.
If the primary chat model fails, the agent retries on the fallback. Both models
are governed identically.

### Options

Standard agent behaviour lives under **Options**: `System Message`,
`Max Iterations`, `Enable Streaming`, `Return Intermediate Steps`,
`On Tool Error`, and `Automatically Passthrough Binary Images`.

### Advanced Governance

Governance behaviour lives in the **Advanced Governance** collection. Defaults
are chosen so the node is useful without configuration.

| Option | Default | Description |
|---|---|---|
| **Governance Events to Send** | all six | Which lifecycle events are evaluated: workflow started/completed, LLM started/completed, tool started/completed. |
| **On API Error** | Fail Open | Whether an unreachable OpenBox API lets the workflow continue ungoverned, or stops it. |
| **Governance Request Timeout (Seconds)** | `30` | HTTP timeout for calls to the OpenBox Core API. |
| **Tools to Exclude From Governance** | *(none)* | Comma-separated tool names whose calls are never governed. |
| **Human-in-the-Loop Approval Enabled** | `true` | Whether the node pauses for approval when a policy demands it. |
| **Approval Poll Interval (Seconds)** | `5` | How often to poll for an approval decision. |
| **Approval Max Wait (Seconds)** | `3600` | How long to wait before halting. `0` waits indefinitely. |
| **Instrument HTTP Calls** | `true` | Capture outgoing HTTP calls (e.g. to the LLM provider) as governance spans. |
| **Instrument Databases** | `true` | Capture database queries made during tool execution as spans. |
| **Database Drivers to Instrument** | all five | Which drivers to patch: `pg`, `mysql2`, `mongodb`, `redis`, `ioredis`. |
| **Instrument File I/O** | `false` | Capture file reads/writes during tool execution as spans. |

### Spans

With instrumentation enabled, each governed activity carries spans for the work
it performed, as a `started` / `completed` pair sharing one span id so the
dashboard can show a real duration.

Spans are only recorded for work that runs **inside a governed activity's async
context**. I/O elsewhere in the n8n process — background jobs, queue polling,
n8n's own persistence between executions — is not captured, by design.

| Kind | Span name | Notes |
|---|---|---|
| HTTP | `POST https://…` (plus the status code on the completed half) | On by default. Covers the LLM provider call and any HTTP-backed tool. |
| PostgreSQL | `SELECT postgresql`, `INSERT postgresql`, … | On by default. Excludes n8n's own queries — see below. |
| MySQL | `SELECT mysql`, … | On by default. |
| MongoDB | `FIND mongodb`, `INSERTONE mongodb`, … | On by default. Named by collection method. |
| Redis | `GET redis`, `HGETALL redis`, … | On by default. Excludes n8n's queue traffic — see below. |
| File I/O | `file.read`, `file.write`, … | **Off** by default. |
| Failed connections | `CONNECT postgresql`, `CONNECT redis`, … | Emitted **only when a connection fails** — see below. |

#### Failed connections

A database that cannot be reached produces no queries, so without this there is
nothing in the trace to explain the failure — the activity simply completes
having done nothing, and a wrong host or an expired password looks identical to
an idle one. A failed connection is therefore reported as a `CONNECT` span
carrying the driver's own error (`getaddrinfo ENOTFOUND …`, `password
authentication failed`, a timeout) and the target host, port and database. The
credential itself is never included.

Successful connections are deliberately **not** reported. They carry nothing the
queries on that connection do not already carry, and since every span is its own
round trip to the OpenBox API, reporting them doubled both the span count and
the runtime of a healthy run.

#### Telling your work apart from n8n's

The node runs inside n8n, so it sees n8n's own database and Redis traffic as
well as the agent's. Two filters separate them:

- **Postgres** — a query is skipped when its call stack shows it came from
  n8n's own ORM (`@n8n/typeorm`). This is deliberately independent of host,
  database and table name, because a self-hosted n8n and an agent's memory very
  often share one database — n8n's own compose setup does exactly that. Vanilla
  TypeORM is *not* excluded: a tool querying its own database through TypeORM is
  the agent's work and is traced.
- **Redis** — a command is skipped when the connection is n8n's Bull queue
  (matching `QUEUE_BULL_REDIS_HOST` and `QUEUE_BULL_REDIS_PORT`, in queue mode)
  or when the command touches n8n's own keys (`bull:*`, `n8n.*`, honouring
  `QUEUE_BULL_PREFIX`).

Both fail toward *showing too much* rather than too little: an unrecognised
internal query appears as one stray span you can see and report, instead of
silently discarding a span you needed.

### Workload identity (v3)

For agents with a workload identity, paste the agent's workload private key
(PEM) into **Workload Private Key**. The node then:

1. reads the agent's identity authority from Core (`GET /api/v3/auth/bootstrap`);
2. exchanges a signed client assertion (RS256) for a short-lived workload token
   at that authority's token endpoint;
3. sends every governance and approval request to Core's v3 API with the API key
   and the token in `X-OpenBox-Workload-Token`.

Tokens are cached for at most five minutes and shared across executions. If Core
rejects one (401/403), it is discarded and the run fails closed, whatever **On API
Error** says; the next request fetches a new one. If Core has no workload identity
for the agent, the node keeps using the v1 API. Only Node's built-in `crypto` is
used, so the package still has no runtime dependencies.

### Advanced: Agent DID signing

For agents configured with `signing_required = true` in OpenBox, fill in the
**Agent DID** and **Agent Private Key** fields in the credential. Every request
to the OpenBox API will be signed with an Ed25519 signature automatically. A
**Workload Private Key**, when set, takes precedence: v3 requests carry the
workload token instead of a DID signature.

### Events

Each run sends `WorkflowStarted`, one `SignalReceived` (`user_prompt`), an
activity per model call (`llm_call`), tool call and memory operation, and closes
with `WorkflowCompleted`, or `WorkflowFailed` when the run ended in an error.
Lifecycle events carry `hook_trigger: false` and a per-run `sequence` number, so
their order is explicit even when two share a millisecond. The final answer is
sent as `activity_output`.

Approvals are polled by the run's workflow, run and activity ids. A decision Core
returns for a *different* approval of the same activity halts the run instead of
being acted on. When a BLOCK verdict carries a suggested input (`patch`), it is
added to the error message the model sees.

### OpenRouter provenance

For every OpenRouter call made inside a governed activity, the node reads
OpenRouter's record of who actually served it (provider, region, model, tokens,
cost, fallback attempts) and sends it to OpenBox as an `llm_provenance` span on
that activity. The record is read after the call returns, with the caller's own
OpenRouter key, and the run waits for it (at most 12 s) before it closes. Set
`OPENBOX_OPENROUTER_PROVENANCE=false` in n8n's environment to turn it off.

## Limitations and known issues

Worth reading before you rely on a trace.

### Governance adds latency

Every event and every span is a round trip to the OpenBox API, and sends are
serialised per activity so ordering is preserved. A run with many database spans
makes proportionally many calls. If that matters, narrow **Governance Events to
Send** or turn off the instrumentation you do not need.

### If the API is unreachable, spans are lost silently

**On API Error** defaults to *Fail Open*: the workflow continues ungoverned and
the spans for that run are simply never recorded, with no failure surfaced in
the workflow. Choose *Fail Closed* if a missing audit trail should stop the run.

### Approval can only gate work that has not happened yet

Database queries are held until the verdict arrives, so `block` or
`require_approval` can prevent one. A verdict on a *completed* span cannot
un-run the work — it is recorded, not enforced. With HITL enabled the node
blocks while polling, up to **Approval Max Wait** (default 3600 s; `0` waits
indefinitely).

### Cost, token counts and LLM classification come from the API, not this node

The node sends the request and response; the OpenBox API decides the span type
and extracts model and usage. If your deployment does not recognise a provider's
domain, that provider's calls are classified as plain HTTP and cost and token
totals stay at zero. This is a server-side gap, not something the node can fix.
For OpenRouter, the provenance span above carries OpenRouter's own token and
cost figures either way.

### Filter caveats

- **Postgres** relies on a call-stack frame. If an async boundary ever drops it,
  one of n8n's own queries can surface as a span. Visible, harmless, reportable.
- **Redis** filtering is verified against a real `ioredis` client and a real
  Bull queue, but has not been observed firing during a live queued execution:
  in local queue-mode testing, n8n's queue traffic never entered a governed
  activity's context, so the filter was never reached. It may behave differently
  on deployments where n8n uses Redis for caching or locking during node
  initialisation.
- **MySQL and MongoDB have no equivalent origin filter.** n8n does not use them
  internally, so there is nothing to exclude — but if n8n or another community
  node did, those queries would appear as agent spans.

### Chat memory issues repeated DDL

n8n's Postgres chat memory runs `CREATE TABLE IF NOT EXISTS` on every load, so
you will see that span on each `load_memory`. It is the memory node's behaviour,
not a duplicate span.

### Testing locally

`n8n execute` on the CLI **does not support queue mode** and silently falls back
to regular mode, so it cannot reproduce anything specific to a queue-mode
deployment. To exercise a worker, run n8n in queue mode and trigger the workflow
so the main instance enqueues it — a schedule trigger is the simplest way.

### Node identity is tied to the node's name

The agent name is derived as `n8n.Agent.<Node_Name>`. Renaming the node in the
canvas starts reporting under a new agent name, which splits your history.

## Package layout

```text
custom-node/
  nodes/OpenBoxAgent/
    OpenBoxAgent.node.ts        the OpenBox: Agent node
    openbox.svg                 node icon
  credentials/
    OpenBoxApi.credentials.ts   the OpenBox API credential
  shared/
    openbox-client.ts           HTTP client for the Core API (v1 or v3)
    workload-identity.ts        v3 workload bootstrap, token exchange and cache
    ignored-urls.ts             URLs the instrumentation never captures
    signing.ts                  Ed25519 request signing
    credential-test.ts          credential connectivity check
    langchain/
      middleware.ts             governance middleware around the agent
      hooks.ts, hook_handlers.ts, tool_hook.ts
      span_processor.ts         activity scope + span lifecycle
      node_instrumentation.ts   http / db / file patches
      hitl.ts                   human-in-the-loop polling
      event-sequence.ts         per-run event ordering
      provenance.ts, residency.ts  OpenRouter routing provenance
      verdict.ts, config.ts, client.ts, error-info.ts, types.ts
  tests/                        vitest suites
  scripts/                      build helpers (clean, copy assets)
```

`main` and the `n8n` manifest point into `dist/`, which is built on `prepack`
and is not checked in.

## Local development

```bash
npm install
npm run build
npm test
npm run lint
```

To verify the package scan passes before publishing:

```bash
npx @n8n/scan-community-package n8n-nodes-openbox-hook
```

Release process is documented in [RELEASING.md](../RELEASING.md).
