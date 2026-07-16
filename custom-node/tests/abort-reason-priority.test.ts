import { describe, expect, it, vi } from 'vitest';

// Simulates the real bug report: a mid-flight governance rejection is thrown
// inside the patched fetch, but the LLM client (e.g. the OpenAI SDK) wraps
// ANY error its fetch implementation throws into its own generic transport
// error ("Connection error.") with no usable trace back to the original —
// so unwrapping the caught error's cause chain alone cannot recover the real
// reason. handleWrapModelCall must instead prefer the reason recorded via
// span_processor's abort side-channel (getActivityAbortReason).
vi.mock('../shared/langchain/span_processor', () => ({
  addIgnoredPrefix: vi.fn(),
  clearActivityAbort: vi.fn(),
  getActivityAbortReason: vi.fn(() => 'Activity rejected: too risky'),
  hasActivityAbort: vi.fn(() => false),
  isActivityApproved: vi.fn(() => false),
  markActivityApproved: vi.fn(),
  registerActivity: vi.fn(),
  runWithActivity: vi.fn(async (_activityId: string, handler: () => Promise<unknown>) => handler()),
  unregisterActivity: vi.fn(),
  unregisterWorkflow: vi.fn(),
}));

import { mergeConfig } from '../shared/langchain/config';
import { handleWrapModelCall } from '../shared/langchain/hook_handlers';
import { handleWrapToolCall } from '../shared/langchain/tool_hook';

function makeMiddleware() {
  return {
    _workflowType: 'TestAgent',
    _config: mergeConfig({ hitl: { pollIntervalMs: 1, timeoutMs: 50 } }),
    _client: {
      updateTraceId: vi.fn(),
      evaluateEvent: vi.fn().mockResolvedValue(null),
      pollApproval: vi.fn(),
    },
  };
}

describe('a governance rejection survives being wrapped by an SDK transport error', () => {
  it('handleWrapModelCall rethrows a clean GovernanceHaltError with the recorded reason, not "Connection error."', async () => {
    const mw = makeMiddleware();
    const turn = { workflowId: 'wf-1', runId: 'run-1' };
    // No .cause, no relation to our error classes at all — an unwrap of the
    // cause chain alone would find nothing here.
    const sdkWrappedError = new Error('Connection error.');
    const handler = vi.fn().mockRejectedValue(sdkWrappedError);

    await expect(
      handleWrapModelCall(mw as never, turn, [['human', 'hi']], handler),
    ).rejects.toMatchObject({ name: 'GovernanceHaltError', message: 'Activity rejected: too risky' });
  });

  it('handleWrapToolCall rethrows a clean GovernanceHaltError with the recorded reason, not the wrapped error', async () => {
    const mw = makeMiddleware();
    const turn = { workflowId: 'wf-1', runId: 'run-1' };
    const sdkWrappedError = new Error('Connection error.');
    const handler = vi.fn().mockRejectedValue(sdkWrappedError);

    await expect(
      handleWrapToolCall(mw as never, turn, 'search', { q: 'x' }, handler),
    ).rejects.toMatchObject({ name: 'GovernanceHaltError', message: 'Activity rejected: too risky' });
  });
});
