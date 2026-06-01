/**
 * OpenBox governance proxy — entry point.
 *
 * Implements gaps.md GAP-16: a forward HTTP proxy that intercepts
 * every outbound request from n8n, asks OpenBox for a verdict, and
 * either forwards or blocks. The proxy is the only mechanism that
 * can block a built-in node's HTTP traffic without forking n8n.
 *
 * Listens on PROXY_PORT (default 8888) and speaks both:
 *   - Plain forward proxy ("absolute-form" requests, e.g.
 *     `GET http://api.example.com/x HTTP/1.1`) for plain HTTP traffic.
 *   - HTTP CONNECT tunneling for HTTPS, with optional pre-check on
 *     the destination host (we cannot read the body inside the TLS
 *     tunnel — that's by design — but we can still gate based on
 *     host + method).
 *
 * Configuration is environment-only; we deliberately avoid a config
 * file so the sidecar is trivial to redeploy via docker-compose.
 */

'use strict';

const http = require('node:http');
const net = require('node:net');
const { URL } = require('node:url');

const { evaluate, allowedVerdict, submitSpan } = require('./governance');
const { log } = require('./logger');

const PROXY_PORT = Number(process.env.PROXY_PORT || 8888);
const NO_PROXY_HOSTS = (process.env.NO_PROXY || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Phase 3: capture req+res bodies and emit an observability span.
// Off by default — set OPENBOX_PROXY_BODY_CAPTURE=true to enable.
// Cap per body to avoid unbounded memory. Self-hosted only.
const BODY_CAPTURE = process.env.OPENBOX_PROXY_BODY_CAPTURE === 'true';
const BODY_CAP = Number(process.env.OPENBOX_PROXY_BODY_CAP_BYTES || 64 * 1024);

/**
 * Whether a destination host should bypass governance entirely.
 * Always exempts the OpenBox API itself (otherwise the proxy would
 * recurse on its own evaluate() call) plus any user-supplied
 * NO_PROXY entries.
 */
function isExempt(host) {
  if (!host) return false;
  if (NO_PROXY_HOSTS.some((entry) => host === entry || host.endsWith(`.${entry}`))) {
    return true;
  }
  try {
    const apiUrl = process.env.OPENBOX_API_URL || '';
    if (apiUrl) {
      const apiHost = new URL(apiUrl).host;
      if (host === apiHost) return true;
    }
  } catch {
    /* invalid OPENBOX_API_URL — fall through */
  }
  return false;
}

function writeBlocked(socket, verdict, target) {
  const reason = (verdict && verdict.reason) || 'Blocked by OpenBox governance';
  const body = JSON.stringify({
    error: 'governance_blocked',
    arm: (verdict && verdict.arm) || 'block',
    reason,
    target,
  });
  socket.write(
    [
      'HTTP/1.1 403 Forbidden',
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'X-OpenBox-Block-Reason: ' + reason.replace(/[\r\n]/g, ' '),
      'Connection: close',
      '',
      body,
    ].join('\r\n'),
  );
  socket.end();
}

function respondBlocked(res, verdict, target) {
  const reason = (verdict && verdict.reason) || 'Blocked by OpenBox governance';
  res.writeHead(403, {
    'Content-Type': 'application/json',
    'X-OpenBox-Block-Reason': reason.replace(/[\r\n]/g, ' '),
    Connection: 'close',
  });
  res.end(
    JSON.stringify({
      error: 'governance_blocked',
      arm: (verdict && verdict.arm) || 'block',
      reason,
      target,
    }),
  );
}

/**
 * Plain HTTP forwarding handler. Reads the inbound request, asks
 * OpenBox for a verdict, and either forwards the request to the real
 * upstream or returns 403.
 */
async function handleHttpRequest(req, res) {
  const target = req.url;
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request: malformed absolute URL');
    return;
  }

  const startWallMs = Date.now();

  if (isExempt(parsed.host)) {
    return forwardHttp(req, res, parsed);
  }

  // Buffer body up to a sensible cap so we can include it in the
  // governance payload. Large bodies are summarized.
  const chunks = [];
  let total = 0;
  const MAX = 64 * 1024;
  let truncated = false;
  for await (const chunk of req) {
    if (total + chunk.length > MAX) {
      truncated = true;
      break;
    }
    chunks.push(chunk);
    total += chunk.length;
  }

  // Phase 2.2 #8 — extract session ID injected by the hooks module
  // (X-OpenBox-Session-Id) for proper workflow attribution in governance.
  const sessionId = req.headers['x-openbox-session-id'] || null;
  const spanMeta = { startWallMs, sessionId, requestTruncated: truncated };

  let verdict;
  try {
    verdict = await evaluate({
      method: req.method,
      url: target,
      headers: req.headers,
      body_truncated: truncated,
      body_preview: Buffer.concat(chunks).toString('utf8').slice(0, MAX),
      ...(sessionId ? { session_id: sessionId, workflow_id: sessionId } : {}),
    });
  } catch (err) {
    // Fail-closed: if governance is unreachable, block. The behavior
    // is configurable via OPENBOX_PROXY_FAIL_OPEN=true.
    log.error('evaluate failed', err);
    if (process.env.OPENBOX_PROXY_FAIL_OPEN === 'true') {
      log.warn('FAIL_OPEN enabled; forwarding without verdict');
      return forwardHttp(req, res, parsed, Buffer.concat(chunks), spanMeta);
    }
    return respondBlocked(res, { reason: 'Governance unreachable' }, target);
  }

  if (!allowedVerdict(verdict)) {
    log.info(`BLOCK ${req.method} ${target} :: ${verdict.arm} :: ${verdict.reason}`);
    return respondBlocked(res, verdict, target);
  }

  return forwardHttp(req, res, parsed, Buffer.concat(chunks), spanMeta);
}

/**
 * Forward a plain-HTTP request to the upstream. Body is provided
 * pre-buffered because the inbound stream has been consumed by the
 * governance check above.
 *
 * Phase 3: when OPENBOX_PROXY_BODY_CAPTURE=true, also buffers the
 * upstream response body (up to BODY_CAP bytes) and emits a
 * post-request observability span containing both request and
 * response previews. This is the safest place to capture bodies
 * because the proxy already has the full plaintext for HTTP traffic.
 * HTTPS bodies remain inaccessible (TLS tunnel).
 */
function forwardHttp(req, res, parsedUrl, bodyBuffer, spanMeta) {
  const startWallMs = spanMeta ? spanMeta.startWallMs : Date.now();

  const upstreamReq = http.request(
    {
      method: req.method,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: stripHopByHop(req.headers),
    },
    (upstreamRes) => {
      if (!BODY_CAPTURE) {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        return;
      }

      // Buffer response body up to BODY_CAP for the span, then pipe
      // the buffered data to the client so it still gets the response.
      const resChunks = [];
      let resTotal = 0;
      let resTruncated = false;

      upstreamRes.on('data', (chunk) => {
        if (resTotal + chunk.length <= BODY_CAP) {
          resChunks.push(chunk);
          resTotal += chunk.length;
        } else if (!resTruncated) {
          resTruncated = true;
        }
      });

      upstreamRes.on('end', () => {
        const resBody = Buffer.concat(resChunks);
        const endWallMs = Date.now();

        // Write response to client.
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        res.end(resBody);

        // Fire-and-forget span — never let this delay the response.
        void submitSpan({
          hook_type: 'http_request',
          session_id: spanMeta ? spanMeta.sessionId : null,
          workflow_id: spanMeta ? spanMeta.sessionId : null,
          http_method: req.method,
          http_url: req.url,
          http_status_code: upstreamRes.statusCode || null,
          start_time_unix_ms: startWallMs,
          end_time_unix_ms: endWallMs,
          duration_ms: endWallMs - startWallMs,
          stage: 'completed',
          request_body_preview: bodyBuffer && bodyBuffer.length > 0
            ? bodyBuffer.toString('utf8').slice(0, BODY_CAP)
            : null,
          request_body_truncated: spanMeta ? spanMeta.requestTruncated : false,
          response_body_preview: resBody.toString('utf8').slice(0, BODY_CAP),
          response_body_truncated: resTruncated,
        });
      });

      upstreamRes.on('error', (err) => {
        log.warn(`response stream error for ${parsedUrl.host}:`, err.message);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end(`Upstream stream error: ${err.message}`);
        }
      });
    },
  );

  upstreamReq.on('error', (err) => {
    log.warn(`upstream error for ${parsedUrl.host}:`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    res.end(`Upstream error: ${err.message}`);
  });

  if (bodyBuffer && bodyBuffer.length > 0) {
    upstreamReq.write(bodyBuffer);
  }
  upstreamReq.end();
}

/**
 * HTTPS CONNECT handler. We can only inspect the destination host
 * before the TLS handshake completes; we never decrypt application
 * traffic. Verdict is derived from method (always "CONNECT") + host.
 */
async function handleConnect(req, clientSocket, head) {
  const [host, portStr] = req.url.split(':');
  const port = Number(portStr) || 443;

  if (isExempt(host)) {
    return tunnel(host, port, clientSocket, head);
  }

  const sessionId = req.headers['x-openbox-session-id'] || null;

  let verdict;
  try {
    verdict = await evaluate({
      method: 'CONNECT',
      url: `https://${host}:${port}`,
      headers: req.headers,
      // No body available — TLS hides it.
      body_preview: null,
      ...(sessionId ? { session_id: sessionId, workflow_id: sessionId } : {}),
    });
  } catch (err) {
    log.error('evaluate (CONNECT) failed', err);
    if (process.env.OPENBOX_PROXY_FAIL_OPEN === 'true') {
      log.warn('FAIL_OPEN enabled; tunneling without verdict');
      return tunnel(host, port, clientSocket, head);
    }
    return writeBlocked(clientSocket, { reason: 'Governance unreachable' }, req.url);
  }

  if (!allowedVerdict(verdict)) {
    log.info(`BLOCK CONNECT ${req.url} :: ${verdict.arm} :: ${verdict.reason}`);
    return writeBlocked(clientSocket, verdict, req.url);
  }

  return tunnel(host, port, clientSocket, head);
}

function tunnel(host, port, clientSocket, head) {
  const upstream = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on('error', (err) => {
    log.warn(`tunnel error for ${host}:${port}:`, err.message);
    try {
      writeBlocked(clientSocket, { reason: `Tunnel error: ${err.message}` }, `${host}:${port}`);
    } catch {
      clientSocket.destroy();
    }
  });

  clientSocket.on('error', (err) => {
    log.debug(`client socket error: ${err.message}`);
    upstream.destroy();
  });
}

/**
 * Strip RFC 7230 "hop-by-hop" headers before forwarding upstream.
 * These are connection-scoped and should not leak across the proxy.
 */
function stripHopByHop(headers) {
  const HOP_BY_HOP = new Set([
    'connection',
    'proxy-connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]);
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

const server = http.createServer((req, res) => {
  // NEW-4: health endpoint for Docker healthcheck — responds before
  // routing to the governance proxy logic so it never hits evaluate().
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', port: PROXY_PORT }));
    return;
  }

  handleHttpRequest(req, res).catch((err) => {
    log.error('handleHttpRequest crashed', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
    }
    res.end('Proxy internal error');
  });
});

server.on('connect', (req, socket, head) => {
  handleConnect(req, socket, head).catch((err) => {
    log.error('handleConnect crashed', err);
    try {
      writeBlocked(socket, { reason: 'Proxy internal error' }, req.url);
    } catch {
      socket.destroy();
    }
  });
});

// Production-grade error handlers to prevent process crashes
process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled promise rejection:', reason);
  // In production, you may want to gracefully shut down or alert monitoring
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', err);
  // Give time for logs to flush, then exit
  setTimeout(() => process.exit(1), 1000);
});

// Only auto-bind when invoked directly (`node src/server.js`). When
// the module is required from a test or another process the consumer
// is responsible for calling `server.listen()` itself; this avoids
// allocating a real port in test runs.
if (require.main === module) {
  server.listen(PROXY_PORT, () => {
    log.info(`OpenBox proxy listening on :${PROXY_PORT}`);
  });

  // Graceful shutdown on SIGTERM/SIGINT
  const shutdown = (signal) => {
    log.info(`Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      log.info('Server closed');
      process.exit(0);
    });
    // Force exit after 10s if graceful shutdown hangs
    setTimeout(() => {
      log.warn('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { server, isExempt, stripHopByHop };
