/**
 * Regression guard for the HTTP instrumentation hang.
 *
 * The instrumentation attaches a 'data' listener to capture the response body
 * for its governance span, which puts the stream into flowing mode. Because the
 * caller's callback is deliberately deferred until the governance verdict
 * settles, the caller used to receive an already-drained, already-ended stream:
 * its own 'data'/'end' listeners never fired and the request hung until the
 * caller's own timeout. n8n's HTTP nodes sit on axios, which is exactly that
 * shape — every HTTP-backed tool hung for 300s.
 *
 * These tests run against a REAL http server through a REAL http.request, so
 * they exercise the actual patched module rather than a mock of it.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

// The instrumentation patches the CJS module object via require('node:http').
// An ESM namespace import snapshots `request`, so calling http.request here
// would silently bypass the patch and the test would pass either way — go
// through the same object the patch mutates.
const requireCjs = createRequire(import.meta.url);

import {
  setupSpanProcessorInstrumentation,
  registerActivity,
  unregisterActivity,
  runWithActivity,
} from '../shared/langchain/span_processor';

let server: http.Server;
let port: number;

const BODY = JSON.stringify({ city: 'London', temp_c: 14 });

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // Split across two writes so a partial replay would be visible.
    res.write(BODY.slice(0, 10));
    res.end(BODY.slice(10));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  setupSpanProcessorInstrumentation({ http: true });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Consume a response the way axios does: subscribe inside the callback. */
function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const httpCjs = requireCjs('node:http') as typeof http;
    const req = httpCjs.request(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Fails the test rather than hanging the suite if the body never arrives. */
function withTimeout<T>(p: Promise<T>, ms = 5000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`timed out after ${ms}ms — response body never delivered`)), ms),
    ),
  ]);
}

describe('HTTP instrumentation body replay', () => {
  it('delivers the full body to the caller when NO activity is registered (fast path)', async () => {
    const res = await withTimeout(get('/plain'));
    expect(res.status).toBe(200);
    expect(res.body).toBe(BODY);
  });

  it('delivers the full body to the caller while an activity IS registered', async () => {
    // This is the case that hung: instrumentation active, so the response is
    // captured for a span and the callback is gated on the verdict.
    const activityId = 'act-replay-1';
    registerActivity(
      activityId,
      {
        source: 'workflow-telemetry',
        workflow_id: 'wf-1',
        run_id: 'run-1',
        workflow_type: 'test',
        task_queue: 'test',
        session_id: 'sess-1',
        event_type: 'ActivityStarted',
        activity_id: activityId,
        activity_type: 'test_tool',
      } as never,
      // evaluateHookSpan fails open when it cannot reach Core — which is the
      // point: even with governance unreachable, the body must still arrive.
      { getNode: () => ({ name: 'test' }) } as never,
      'trace-1',
      {
        hitl: { enabled: false, pollIntervalMs: 1000, timeoutMs: 1000 },
        onApiError: 'fail_open',
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        requestTimeoutMs: 2000,
      } as never,
    );

    try {
      const res = await runWithActivity(activityId, () => withTimeout(get('/governed')));
      expect(res.status).toBe(200);
      expect(res.body).toBe(BODY);
    } finally {
      unregisterActivity(activityId);
    }
  });
});

// ── Stable span ids across the started/completed pair ────────────────────────
describe('span_id correlation', () => {
  it('gives the started and completed halves of one operation the SAME span_id', async () => {
    const { buildHttpSpanData } = await import('../shared/langchain/span_processor');
    const common = { activityId: 'act-1', method: 'POST', url: 'https://x.test/v1/chat', startMs: 1000 };
    const started = buildHttpSpanData({ ...common, stage: 'started' } as never) as Record<string, unknown>;
    const completed = buildHttpSpanData({
      ...common, stage: 'completed', endMs: 1200, statusCode: 200,
    } as never) as Record<string, unknown>;
    // Core creates the row on 'started' and fills duration from 'completed',
    // matching them by span_id — differing ids leave spans stuck at "started".
    expect(started.span_id).toBe(completed.span_id);
    expect(String(started.span_id)).toHaveLength(16);
  });

  it('gives different operations different span_ids', async () => {
    const { buildHttpSpanData } = await import('../shared/langchain/span_processor');
    const a = buildHttpSpanData({ activityId:'act-1', method:'POST', url:'https://x.test/a', startMs:1000, stage:'started' } as never) as Record<string, unknown>;
    const b = buildHttpSpanData({ activityId:'act-1', method:'POST', url:'https://x.test/b', startMs:1000, stage:'started' } as never) as Record<string, unknown>;
    expect(a.span_id).not.toBe(b.span_id);
  });
});

// ── Status code exposed where the dashboard reads it ─────────────────────────
describe('http span attributes', () => {
  const build = async (opts: Record<string, unknown>) => {
    const { buildHttpSpanData } = await import('../shared/langchain/span_processor');
    return buildHttpSpanData(opts as never) as Record<string, unknown>;
  };
  const LLM = 'https://openrouter.ai/api/v1/chat/completions';

  it('puts the status code in attributes, where the dashboard reads it', async () => {
    const span = await build({
      activityId: 'a', method: 'POST', url: LLM, startMs: 1,
      stage: 'completed', endMs: 2, statusCode: 200,
    });
    const attrs = span.attributes as Record<string, unknown>;
    // Canonical OTel key, per openbox-executor telemetry._http_attributes.
    expect(attrs['http.status_code']).toBe(200);
    expect((span.status as Record<string, unknown>).code).toBe('OK');
  });

  it('declares semantic_type llm_completion and keeps gen_ai.system OUT of attributes', async () => {
    const span = await build({
      activityId: 'a', method: 'POST', url: LLM, startMs: 1,
      stage: 'completed', endMs: 2, statusCode: 200,
    });
    expect(span.semantic_type).toBe('llm_completion');
    // gen_ai.system in attributes makes Core classify the span 'llm_gen_ai',
    // whose dashboard branch hardcodes statusCode: null and drops the status
    // pill. The provider still travels as the root field.
    const attrs = span.attributes as Record<string, unknown>;
    expect('gen_ai.system' in attrs).toBe(false);
    expect(span.gen_ai_system).toBe('openrouter');
  });

  it('leaves semantic_type unset for a non-LLM call', async () => {
    const span = await build({
      activityId: 'a', method: 'POST', url: 'https://x.test/webhook', startMs: 1,
      stage: 'completed', endMs: 2, statusCode: 204,
    });
    expect(span.semantic_type).toBeUndefined();
    expect((span.attributes as Record<string, unknown>)['http.status_code']).toBe(204);
  });

  it('omits status on a started span, which has no status yet', async () => {
    const span = await build({ activityId: 'a', method: 'POST', url: LLM, startMs: 1, stage: 'started' });
    const attrs = span.attributes as Record<string, unknown>;
    expect('http.status_code' in attrs).toBe(false);
    expect((span.status as Record<string, unknown>).code).toBe('UNSET');
  });

  it('reports ERROR status on a failed completion', async () => {
    const span = await build({
      activityId: 'a', method: 'POST', url: LLM, startMs: 1, stage: 'completed', endMs: 2,
      statusCode: 500, error: 'boom',
    });
    expect((span.status as Record<string, unknown>).code).toBe('ERROR');
  });
});
