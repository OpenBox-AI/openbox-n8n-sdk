import { describe, expect, it, vi } from 'vitest';

import { mergeConfig } from '../shared/langchain/config';
import { handleAfterAgent, handleBeforeAgent, handleWrapModelCall } from '../shared/langchain/hook_handlers';
import { handleWrapToolCall } from '../shared/langchain/tool_hook';
import { isMonotonic } from '../shared/langchain/event-sequence';

function makeMiddleware() {
  return {
    _workflowType: 'n8n.Agent.Test',
    _config: mergeConfig({ taskQueue: 'n8n', hitl: { pollIntervalMs: 1, timeoutMs: 50 } }),
    _client: {
      updateTraceId: vi.fn(),
      evaluateEvent: vi.fn().mockResolvedValue(null),
      pollApproval: vi.fn().mockResolvedValue({ verdict: 'allow' }),
      executeFunctions: {} as never,
    },
  };
}

function sent(mw: ReturnType<typeof makeMiddleware>): Array<Record<string, unknown>> {
  return mw._client.evaluateEvent.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

describe('event model', () => {
  it('stamps every lifecycle event with hook_trigger false and a gapless sequence', async () => {
    const mw = makeMiddleware();
    const turn = await handleBeforeAgent(mw as never, { messages: [['human', 'hi']] }, 'thread-1');
    await handleWrapModelCall(mw as never, turn, [['human', 'hi']], async () => ({ content: 'hello' }));
    await handleWrapToolCall(mw as never, turn, 'lookup', { q: 1 }, async () => 'found');
    await handleAfterAgent(mw as never, turn, { messages: [{ content: 'done' }] });

    const events = sent(mw);
    expect(events.map((e) => e.event_type)).toEqual([
      'WorkflowStarted',
      'SignalReceived',
      'LLMStarted',
      'LLMCompleted',
      'ToolStarted',
      'ToolCompleted',
      'WorkflowCompleted',
    ]);
    expect(events.every((e) => e.hook_trigger === false)).toBe(true);
    expect(isMonotonic(events as never)).toBe(true);
  });

  it('closes a successful run with WorkflowCompleted carrying the answer as activity_output', async () => {
    const mw = makeMiddleware();
    const turn = { workflowId: 'wf-1', runId: 'run-1' };
    await handleAfterAgent(mw as never, turn, { messages: [{ content: 'the answer' }] });
    expect(sent(mw)[0]).toMatchObject({
      activity_id: 'run-1-wf',
      activity_output: { result: 'the answer' },
      event_type: 'WorkflowCompleted',
      status: 'completed',
    });
  });

  it('closes a failed run with WorkflowFailed and the error', async () => {
    const mw = makeMiddleware();
    const turn = { workflowId: 'wf-2', runId: 'run-2' };
    await handleAfterAgent(mw as never, turn, { messages: [] }, new Error('model unavailable'));
    expect(sent(mw)[0]).toMatchObject({
      error: { message: 'model unavailable', type: 'Error' },
      event_type: 'WorkflowFailed',
      status: 'failed',
    });
  });

  it('closes a tool refused at its start with the reason and the original input', async () => {
    const mw = makeMiddleware();
    mw._client.evaluateEvent
      .mockResolvedValueOnce({ verdict: 'block', reason: 'not allowed' })
      .mockResolvedValueOnce(null);
    const turn = { workflowId: 'wf-3', runId: 'run-3' };
    await expect(
      handleWrapToolCall(mw as never, turn, 'deleteCustomer', { id: 'C-42' }, async () => 'deleted'),
    ).rejects.toThrow(/not allowed/);
    expect(sent(mw)[1]).toMatchObject({
      activity_input: [{ id: 'C-42' }],
      activity_output: { result: expect.stringContaining('not allowed') },
      event_type: 'ToolCompleted',
      status: 'failed',
      tool_name: 'deleteCustomer',
    });
  });
});
