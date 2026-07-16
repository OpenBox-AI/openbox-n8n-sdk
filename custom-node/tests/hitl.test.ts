import { describe, expect, it, vi } from 'vitest';

import { mergeConfig } from '../shared/langchain/config';
import { pollApprovalOrHalt } from '../shared/langchain/hitl';

function makeMiddleware(pollApproval: ReturnType<typeof vi.fn>) {
  return {
    _config: mergeConfig({ hitl: { pollIntervalMs: 1, timeoutMs: 200 } }),
    _client: { pollApproval },
  };
}

describe('pollApprovalOrHalt — require_approval must actually wait', () => {
  it('keeps polling on a pending response with no arm/verdict/action, instead of treating it as allow', async () => {
    const pollApproval = vi
      .fn()
      // Two "still pending" responses — no verdict field at all, just an id.
      .mockResolvedValueOnce({ id: 'appr-1', expired: false })
      .mockResolvedValueOnce({ id: 'appr-1', expired: false })
      // Then a human approves.
      .mockResolvedValueOnce({ id: 'appr-1', arm: 'allow' });
    const mw = makeMiddleware(pollApproval);

    await expect(
      pollApprovalOrHalt(mw as never, { workflowId: 'wf-1', runId: 'run-1' }, 'act-1', 'search'),
    ).resolves.toBeUndefined();

    // Must have actually polled three times, not returned on the first tick.
    expect(pollApproval).toHaveBeenCalledTimes(3);
  });

  it('rejects when a human rejects (block/halt), not before', async () => {
    const pollApproval = vi
      .fn()
      .mockResolvedValueOnce({ id: 'appr-1', expired: false })
      .mockResolvedValueOnce({ id: 'appr-1', arm: 'block', reason: 'no' });
    const mw = makeMiddleware(pollApproval);

    await expect(
      pollApprovalOrHalt(mw as never, { workflowId: 'wf-1', runId: 'run-1' }, 'act-1', 'search'),
    ).rejects.toThrow(/rejected/i);
    expect(pollApproval).toHaveBeenCalledTimes(2);
  });

  it('still resolves immediately when Core sends an explicit allow verdict on the first poll', async () => {
    const pollApproval = vi.fn().mockResolvedValueOnce({ id: 'appr-1', arm: 'allow' });
    const mw = makeMiddleware(pollApproval);

    await expect(
      pollApprovalOrHalt(mw as never, { workflowId: 'wf-1', runId: 'run-1' }, 'act-1', 'search'),
    ).resolves.toBeUndefined();
    expect(pollApproval).toHaveBeenCalledTimes(1);
  });

  it('times out if the approval never resolves', async () => {
    const pollApproval = vi.fn().mockResolvedValue({ id: 'appr-1', expired: false });
    const mw = makeMiddleware(pollApproval);

    await expect(
      pollApprovalOrHalt(mw as never, { workflowId: 'wf-1', runId: 'run-1' }, 'act-1', 'search'),
    ).rejects.toThrow(/timed out/i);
  });
});
