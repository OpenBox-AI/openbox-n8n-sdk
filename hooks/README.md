# OpenBox external hooks for self-hosted n8n

This directory implements the **Phase 2** observability layer from
`gaps.md`:

| Gap | Implementation |
|---|---|
| GAP-10 | `workflow.preExecute` / `workflow.postExecute` lifecycle hooks |
| GAP-12 | Automatic HTTP span capture via Node.js `diagnostics_channel` |
| GAP-12b | Automatic Postgres span capture via `pg.Client.prototype.query` patch |
| GAP-13 | Module-level session registry, abort-flag set, pending-span WeakMap |

It is **only available on self-hosted n8n** — n8n Cloud does not
expose `EXTERNAL_HOOK_FILES`.

## Files

| File | Purpose |
|---|---|
| `openbox-hooks.js` | Entry point wired into `EXTERNAL_HOOK_FILES`. Exports the `n8n.ready`, `workflow.preExecute`, `workflow.postExecute` hook arrays. |
| `openbox-hooks-state.js` | Shared in-memory state (`sessions`, `abortedExecutions`, `pendingHttpSpans`). |
| `openbox-hooks-transport.js` | `fetch`-based span/event submitter with self-filter, bounded concurrency, and timeouts. |
| `openbox-hooks-http.js` | `diagnostics_channel` subscriber for outbound HTTP. |
| `openbox-hooks-db.js` | `pg.Client.prototype.query` patcher. |

Pure CommonJS, zero external dependencies; safe to load via
`EXTERNAL_HOOK_FILES`.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `OPENBOX_API_URL` | _(required)_ | Base URL of OpenBox Core. |
| `OPENBOX_API_KEY` | _(required)_ | Agent API key (`obx_live_*` / `obx_test_*`). |
| `OPENBOX_HOOKS_ENABLED` | `true` | Master switch. Set to `false` to load the file but stay inert. |
| `OPENBOX_HOOKS_HTTP` | `true` | Enable / disable HTTP span capture. |
| `OPENBOX_HOOKS_DB` | `true` | Enable / disable Postgres span capture. |
| `OPENBOX_HOOKS_DEBUG` | `false` | Verbose logging to stdout. |

## Wiring it up

In any of the docker-compose files in this directory:

```yaml
services:
  n8n:
    environment:
      EXTERNAL_HOOK_FILES: /opt/openbox-hooks/openbox-hooks.js
      OPENBOX_API_URL: ${OPENBOX_API_URL}
      OPENBOX_API_KEY: ${OPENBOX_API_KEY}
    volumes:
      - ./hooks:/opt/openbox-hooks:ro
```

The `n8n` user inside the container reads the file at startup; the
`:ro` mount keeps the host copy authoritative.

## Limitations

* **Observe-only.** `diagnostics_channel` cannot block a request.
  For HTTP blocking against built-in nodes, deploy the optional
  governance proxy sidecar (gaps.md GAP-16).
* **No per-node attribution.** n8n exposes no per-node lifecycle
  hooks, so the HTTP/DB capture associates spans with the youngest
  active session rather than a specific node.
* **No HALT termination.** When OpenBox returns a HALT verdict, the
  hook flips the abort flag for the session — subsequent spans
  stop being submitted, but n8n's running execution continues to
  completion. Hard termination is gaps.md "Not Feasible".
