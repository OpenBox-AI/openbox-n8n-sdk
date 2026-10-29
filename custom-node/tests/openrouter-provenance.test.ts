/**
 * OpenRouter provenance through the real fetch patch: a governed activity
 * makes one OpenRouter call, and once the activity closes the node reads the
 * generation record (with the caller's own key) and sends it to Core as an
 * `llm_provenance` hook span.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { mergeConfig } from '../shared/langchain/config';
import {
  drainRoutingAttestations,
  extractGenerationId,
  isOpenRouterModelCall,
  registerActivity,
  runWithActivity,
  setupSpanProcessorInstrumentation,
  unregisterActivity,
} from '../shared/langchain/span_processor';

const COMPLETION = {
  id: 'gen-123',
  model: 'openai/gpt-4o-mini',
  provider: 'OpenAI',
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Example Domain' } }],
  usage: { prompt_tokens: 40, completion_tokens: 7, cost: 0.00012 },
};
const GENERATION_RECORD = {
  data: {
    model: 'openai/gpt-4o-mini',
    provider_name: 'OpenAI',
    data_region: 'us',
    latency: 812,
    tokens_prompt: 40,
    tokens_completion: 7,
    total_cost: 0.00012,
    finish_reason: 'stop',
  },
};

const lookups: Array<{ url: string; authorization: string | null }> = [];
/** Whether OpenRouter has published the generation record yet. */
let recordPublished = true;

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

beforeAll(() => {
  // Stubbed before the patch is installed, so the patch wraps this double.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://openrouter.ai/api/v1/generation')) {
      lookups.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      return recordPublished ? json(GENERATION_RECORD) : new Response('{}', { status: 404 });
    }
    return json(COMPLETION, { 'x-generation-id': 'gen-123' });
  }));
  setupSpanProcessorInstrumentation({ http: true });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('OpenRouter provenance helpers', () => {
  it('recognises model calls but never the generation lookup', () => {
    expect(isOpenRouterModelCall('https://openrouter.ai/api/v1/chat/completions')).toBe(true);
    expect(isOpenRouterModelCall('https://openrouter.ai/api/v1/generation?id=gen-1')).toBe(false);
    expect(isOpenRouterModelCall('https://api.openai.com/v1/chat/completions')).toBe(false);
  });

  it('reads the generation id from the header, a JSON body, or an SSE stream', () => {
    expect(extractGenerationId('gen-h', null)).toBe('gen-h');
    expect(extractGenerationId(null, JSON.stringify({ id: 'gen-b' }))).toBe('gen-b');
    expect(extractGenerationId(null, `data: ${JSON.stringify({ id: 'gen-s', choices: [] })}\n\ndata: [DONE]\n`)).toBe('gen-s');
    expect(extractGenerationId(null, JSON.stringify({ id: 'chatcmpl-1' }))).toBeNull();
  });
});

describe('provenance span', () => {
  it('is sent for an OpenRouter call once its activity closes', async () => {
    const coreCalls: Array<Record<string, unknown>> = [];
    recordPublished = true;
    const executeFunctions = {
      getCredentials: async () => ({ apiKey: 'obx_live_test' }),
      getNode: () => ({ name: 'OpenBox Agent' }),
      helpers: {
        httpRequest: vi.fn(async (options: { body?: Buffer }) => {
          coreCalls.push(JSON.parse(options.body!.toString('utf-8')) as Record<string, unknown>);
          return JSON.stringify({ verdict: 'allow' });
        }),
      },
    };
    const config = mergeConfig({});
    registerActivity(
      'act-llm',
      {
        source: 'workflow-telemetry',
        workflow_id: 'wf-1',
        run_id: 'run-1',
        workflow_type: 'n8n.Agent.Test',
        task_queue: 'n8n',
        session_id: undefined,
        event_type: 'ActivityStarted',
        activity_id: 'act-llm',
        activity_type: 'llm_call',
      },
      executeFunctions as never,
      'wf-1',
      { hitl: config.hitl, onApiError: 'fail_open', logger: config.logger, requestTimeoutMs: 1000 },
    );

    const response = await runWithActivity('act-llm', () =>
      fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer sk-or-test', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] }),
      }),
    );
    // The caller still gets the full body.
    expect(await response.json()).toEqual(COMPLETION);

    await unregisterActivity('act-llm');
    await drainRoutingAttestations();

    // The lookup used the caller's own key.
    expect(lookups).toEqual([
      { url: 'https://openrouter.ai/api/v1/generation?id=gen-123', authorization: 'Bearer sk-or-test' },
    ]);

    const hookTypes = coreCalls.map((c) => (c.spans as Array<Record<string, unknown>>)[0].hook_type);
    expect(hookTypes).toEqual(['http_request', 'http_request', 'llm_provenance']);
    const provenance = (coreCalls[2].spans as Array<Record<string, unknown>>)[0];
    expect(coreCalls[2]).toMatchObject({ activity_id: 'act-llm', activity_type: 'llm_call', hook_trigger: true, span_count: 1 });
    expect(provenance).toMatchObject({
      activity_id: 'act-llm',
      gen_ai_system: 'OpenAI',
      name: 'served by OpenAI (openai/gpt-4o-mini)',
      semantic_type: 'llm_provenance',
      stage: 'completed',
    });
    expect(provenance.attributes).toMatchObject({
      'gen_ai.generation.id': 'gen-123',
      'gen_ai.upstream.provider': 'OpenAI',
      'gen_ai.upstream.data_region': 'us',
      'openbox.provenance.source': 'generation_record',
    });
  });

  it('falls back to the response when OpenRouter has not published the record yet', async () => {
    recordPublished = false;
    const coreCalls: Array<Record<string, unknown>> = [];
    const executeFunctions = {
      getCredentials: async () => ({ apiKey: 'obx_live_test' }),
      getNode: () => ({ name: 'OpenBox Agent' }),
      helpers: {
        httpRequest: vi.fn(async (options: { body?: Buffer }) => {
          coreCalls.push(JSON.parse(options.body!.toString('utf-8')) as Record<string, unknown>);
          return JSON.stringify({ verdict: 'allow' });
        }),
      },
    };
    const config = mergeConfig({});
    registerActivity(
      'act-late',
      {
        source: 'workflow-telemetry', workflow_id: 'wf-2', run_id: 'run-2', workflow_type: 'n8n.Agent.Test',
        task_queue: 'n8n', session_id: undefined, event_type: 'ActivityStarted', activity_id: 'act-late', activity_type: 'llm_call',
      },
      executeFunctions as never,
      'wf-2',
      { hitl: config.hitl, onApiError: 'fail_open', logger: config.logger, requestTimeoutMs: 1000 },
    );
    const response = await runWithActivity('act-late', () =>
      fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer sk-or-test' },
        body: JSON.stringify({ model: 'openai/gpt-4o-mini', messages: [] }),
      }),
    );
    await response.json();
    await unregisterActivity('act-late');
    await drainRoutingAttestations();

    const provenance = (coreCalls.at(-1)!.spans as Array<Record<string, unknown>>)[0];
    expect(provenance.hook_type).toBe('llm_provenance');
    expect(provenance.attributes).toMatchObject({
      'gen_ai.generation.id': 'gen-123',
      'gen_ai.upstream.provider': 'OpenAI',
      'gen_ai.response.model': 'openai/gpt-4o-mini',
      'gen_ai.usage.tokens_prompt': 40,
      'openbox.provenance.source': 'response',
    });
  }, 30_000);
});
