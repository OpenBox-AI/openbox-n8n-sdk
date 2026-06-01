# OpenBox governance proxy (Phase 3)

Optional forward HTTP proxy that pre-checks every outbound n8n
request with OpenBox and **blocks on non-allow verdicts**. This is
the only mechanism that can block a built-in node's HTTP traffic
(Slack, HubSpot, HTTP Request, ...) without forking n8n.

Implements `gaps.md` GAP-16.

## How it works

1. n8n runs with `HTTP_PROXY=http://openbox-proxy:8888` and
   `HTTPS_PROXY=http://openbox-proxy:8888`.
2. Every outbound HTTP request from any n8n node is routed through
   this sidecar.
3. The proxy buffers the request and POSTs a descriptor to
   `/api/v1/governance/evaluate` on OpenBox Core.
4. **Allow / Constrain** → the proxy forwards the request to the
   real upstream and pipes the response back.
5. **Block / Halt / Require Approval** → the proxy returns
   `403 Forbidden` with `X-OpenBox-Block-Reason` and a JSON body. The
   n8n node fails with a clear error.

HTTPS uses the standard `CONNECT` tunneling pattern — the proxy
verdict is based on method + host (the body is encrypted and we never
decrypt it). For payload-level governance of HTTPS endpoints, route
the request through the explicit `OpenBox` action node instead.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PROXY_PORT` | `8888` | Listen port. |
| `OPENBOX_API_URL` | _(required)_ | Base URL of OpenBox Core. |
| `OPENBOX_API_KEY` | _(required)_ | Agent API key. |
| `OPENBOX_PROXY_TIMEOUT_MS` | `5000` | Per-evaluate timeout. |
| `OPENBOX_PROXY_FAIL_OPEN` | `false` | If `true`, forward when OpenBox is unreachable. |
| `OPENBOX_PROXY_DEBUG` | `false` | Verbose logging. |
| `NO_PROXY` | _(empty)_ | Comma-separated hosts to bypass entirely. |

The proxy automatically exempts the OpenBox API itself, so adding
`core.openbox.ai` (or your private Core hostname) to `NO_PROXY` is
not required but harmless.

## Wiring it up (docker-compose)

```yaml
services:
  openbox-proxy:
    build: ./openbox-proxy
    environment:
      OPENBOX_API_URL: ${OPENBOX_API_URL}
      OPENBOX_API_KEY: ${OPENBOX_API_KEY}
      PROXY_PORT: '8888'
      NO_PROXY: 'postgres,localhost,host.docker.internal'
    ports: ['8888:8888']

  n8n:
    environment:
      HTTP_PROXY: http://openbox-proxy:8888
      HTTPS_PROXY: http://openbox-proxy:8888
      NO_PROXY: 'core.openbox.ai,postgres,localhost'
    depends_on:
      openbox-proxy:
        condition: service_started
```

## Limitations

- **HTTPS body is opaque.** The proxy can block based on host /
  method, but cannot inspect TLS-encrypted payloads. Use the
  explicit OpenBox node for payload-level governance.
- **Latency.** Adds one synchronous OpenBox call per outbound
  request. Tune `OPENBOX_PROXY_TIMEOUT_MS` for your environment.
- **Cannot block non-HTTP traffic** (raw Postgres TCP, file I/O).
  Use the Phase 2 hooks (`./hooks`) for Postgres observability.
- **Not available on n8n Cloud** — the cloud runtime does not allow
  setting `HTTP_PROXY` / `HTTPS_PROXY`.
