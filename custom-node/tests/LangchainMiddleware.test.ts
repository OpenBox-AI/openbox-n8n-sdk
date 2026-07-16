import { describe, expect, it, vi } from 'vitest';

import { mergeConfig } from '../shared/langchain/config';
import { handleBeforeAgent, handleWrapModelCall } from '../shared/langchain/hook_handlers';
import { handleWrapToolCall } from '../shared/langchain/tool_hook';
import { enforceVerdict, verdictFromString } from '../shared/langchain/verdict';

function makeMiddleware() {
  return {
    _workflowType: 'TestAgent',
    _config: mergeConfig({
      taskQueue: 'n8n',
      hitl: { pollIntervalMs: 1, timeoutMs: 50 },
    }),
    _client: {
      updateTraceId: vi.fn(),
      evaluateEvent: vi.fn(),
      pollApproval: vi.fn().mockResolvedValue({ verdict: 'allow' }),
      executeFunctions: {} as never,
    },
  };
}

describe('LangChain Python parity', () => {
  it('parses Python SDK verdict aliases', () => {
    expect(verdictFromString('continue')).toBe('allow');
    expect(verdictFromString('stop')).toBe('halt');
    expect(verdictFromString('require-approval')).toBe('require_approval');
    expect(verdictFromString('constrain')).toBe('constrain');
  });

  it('returns HITL result instead of throwing on require_approval', () => {
    const result = enforceVerdict({ verdict: 'require_approval' }, 'llm_start');
    expect(result.requiresHitl).toBe(true);
  });

  it('mints and returns turn identity during beforeAgent, never storing it on the instance', async () => {
    const mw = makeMiddleware();
    mw._client.evaluateEvent.mockResolvedValue(null);

    const turn = await handleBeforeAgent(
      mw as never,
      { messages: [['human', 'approve this']] },
      'thread-1',
    );

    expect(turn.workflowId).toContain('thread-1');
    expect(turn.runId).toContain('thread-1');
    // The old design stored these as mutable fields on the middleware instance.
    expect((mw as unknown as Record<string, unknown>)._workflowId).toBeUndefined();
  });

  it('enforces the SignalReceived verdict — a block on the initial signal halts before WorkflowStarted-adjacent work', async () => {
    const mw = makeMiddleware();
    mw._client.evaluateEvent
      .mockResolvedValueOnce(null) // WorkflowStarted
      .mockResolvedValueOnce({ verdict: 'block', reason: 'nope' }) // SignalReceived
      .mockResolvedValueOnce(null); // orphan closure

    await expect(
      handleBeforeAgent(mw as never, { messages: [['human', 'do something bad']] }, 'thread-2'),
    ).rejects.toThrow();

    // 3 calls: WorkflowStarted, SignalReceived, orphan ActivityCompleted closure.
    expect(mw._client.evaluateEvent).toHaveBeenCalledTimes(3);
    const closureEvent = mw._client.evaluateEvent.mock.calls[2][0];
    expect(closureEvent.event_type).toBe('ActivityCompleted');
    expect(closureEvent.status).toBe('failed');
    expect(typeof closureEvent.error).toBe('object');
  });

  it('polls approval during model start HITL before invoking model', async () => {
    const mw = makeMiddleware();
    const turn = { workflowId: 'wf-1', runId: 'run-1' };
    mw._client.evaluateEvent
      .mockResolvedValueOnce({ verdict: 'require_approval' })
      .mockResolvedValueOnce(null);
    const handler = vi.fn().mockResolvedValue({ content: 'done' });

    await handleWrapModelCall(mw as never, turn, [['human', 'hello']], handler);

    expect(mw._client.pollApproval).toHaveBeenCalledWith(
      'wf-1',
      'run-1',
      expect.any(String),
      undefined,
      'fail_open',
    );
    expect(handler).toHaveBeenCalledOnce();
  });

  it('governs an empty-prompt model call instead of silently skipping it', async () => {
    const mw = makeMiddleware();
    mw._client.evaluateEvent.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const handler = vi.fn().mockResolvedValue({ content: 'done' });

    await handleWrapModelCall(mw as never, { workflowId: 'wf-1', runId: 'run-1' }, [['ai', '']], handler);

    expect(mw._client.evaluateEvent).toHaveBeenCalled();
    const startEvent = mw._client.evaluateEvent.mock.calls[0][0];
    expect(startEvent.event_type).toBe('LLMStarted');
  });

  it('polls approval during tool start HITL before invoking tool', async () => {
    const mw = makeMiddleware();
    const turn = { workflowId: 'wf-1', runId: 'run-1' };
    mw._client.evaluateEvent
      .mockResolvedValueOnce({ verdict: 'require_approval' })
      .mockResolvedValueOnce(null);
    const handler = vi.fn().mockResolvedValue('tool result');

    await handleWrapToolCall(mw as never, turn, 'search', { q: 'x' }, handler);

    expect(mw._client.pollApproval).toHaveBeenCalledWith(
      'wf-1',
      'run-1',
      expect.any(String),
      undefined,
      'fail_open',
    );
    expect(handler).toHaveBeenCalledOnce();
  });

  it('closes an orphaned tool row (same activity id) when ToolStarted is blocked', async () => {
    const mw = makeMiddleware();
    const turn = { workflowId: 'wf-1', runId: 'run-1' };
    mw._client.evaluateEvent
      .mockResolvedValueOnce({ verdict: 'block', reason: 'blocked' }) // ToolStarted
      .mockResolvedValueOnce(null); // orphan ToolCompleted closure
    const handler = vi.fn();

    await expect(handleWrapToolCall(mw as never, turn, 'search', { q: 'x' }, handler)).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();

    const startCall = mw._client.evaluateEvent.mock.calls[0][0];
    const closureCall = mw._client.evaluateEvent.mock.calls[1][0];
    expect(closureCall.event_type).toBe('ToolCompleted');
    // Same activity id as the start event — not a "-c" suffixed orphan id.
    expect(closureCall.activity_id).toBe(startCall.activity_id);
    expect(closureCall.status).toBe('failed');
  });

  it('keeps two concurrent turns processed through the same handler isolated', async () => {
    const mw = makeMiddleware();
    mw._client.evaluateEvent.mockResolvedValue(null);

    const [turnA, turnB] = await Promise.all([
      handleBeforeAgent(mw as never, { messages: [['human', 'prompt A']] }, 'thread-A'),
      handleBeforeAgent(mw as never, { messages: [['human', 'prompt B']] }, 'thread-B'),
    ]);

    expect(turnA.workflowId).not.toBe(turnB.workflowId);
    expect(turnA.workflowId).toContain('thread-A');
    expect(turnB.workflowId).toContain('thread-B');

    const handlerA = vi.fn().mockResolvedValue({ content: 'A' });
    const handlerB = vi.fn().mockResolvedValue({ content: 'B' });

    await Promise.all([
      handleWrapModelCall(mw as never, turnA, [['human', 'prompt A']], handlerA),
      handleWrapModelCall(mw as never, turnB, [['human', 'prompt B']], handlerB),
    ]);

    const workflowIdsSent = mw._client.evaluateEvent.mock.calls.map((c) => c[0].workflow_id);
    // Every event tagged with turnA's workflow_id must correspond to prompt A's
    // flow and vice versa — no cross-contamination between the two turns.
    expect(new Set(workflowIdsSent)).toEqual(new Set([turnA.workflowId, turnB.workflowId]));
  });
});
