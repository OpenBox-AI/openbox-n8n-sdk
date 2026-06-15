import { describe, expect, it, vi } from 'vitest';

import { mergeConfig } from '../src/shared/langchain/config';
import { handleBeforeAgent, handleWrapModelCall } from '../src/shared/langchain/hook_handlers';
import { handleWrapToolCall } from '../src/shared/langchain/tool_hook';
import { enforceVerdict, verdictFromString } from '../src/shared/langchain/verdict';

function makeMiddleware() {
  return {
    _workflowId: '',
    _runId: '',
    _workflowType: 'TestAgent',
    _firstLlmCall: true,
    _preScreenResponse: null,
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

  it('resolves without throwing during beforeAgent pre-screen', async () => {
    const mw = makeMiddleware();
    // evaluateEvent resolves for SignalReceived + WorkflowStarted
    mw._client.evaluateEvent
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(
      handleBeforeAgent(
        mw as never,
        { messages: [['human', 'approve this']] },
        'thread-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('polls approval during model start HITL before invoking model', async () => {
    const mw = makeMiddleware();
    mw._firstLlmCall = false;
    mw._workflowId = 'wf-1';
    mw._runId = 'run-1';
    mw._client.evaluateEvent
      .mockResolvedValueOnce({ verdict: 'require_approval' })
      .mockResolvedValueOnce(null);
    const handler = vi.fn().mockResolvedValue({ content: 'done' });

    await handleWrapModelCall(mw as never, [['human', 'hello']], handler);

    expect(mw._client.pollApproval).toHaveBeenCalledWith(
      'wf-1',
      'run-1',
      expect.any(String),
      undefined,
    );
    expect(handler).toHaveBeenCalledOnce();
  });

  it('polls approval during tool start HITL before invoking tool', async () => {
    const mw = makeMiddleware();
    mw._workflowId = 'wf-1';
    mw._runId = 'run-1';
    mw._client.evaluateEvent
      .mockResolvedValueOnce({ verdict: 'require_approval' })
      .mockResolvedValueOnce(null);
    const handler = vi.fn().mockResolvedValue('tool result');

    await handleWrapToolCall(mw as never, 'search', { q: 'x' }, handler);

    expect(mw._client.pollApproval).toHaveBeenCalledWith(
      'wf-1',
      'run-1',
      expect.any(String),
      undefined,
    );
    expect(handler).toHaveBeenCalledOnce();
  });
});
