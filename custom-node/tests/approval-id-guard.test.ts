import { describe, expect, it, vi } from 'vitest';

import { GovernanceClient } from '../shared/langchain/client';
import { mergeConfig } from '../shared/langchain/config';
import { pollApprovalOrHalt } from '../shared/langchain/hitl';
import { awaitedApprovalId, enforceVerdict, isDecisionForAnotherApproval } from '../shared/langchain/verdict';

function makeMiddleware(pollApproval: ReturnType<typeof vi.fn>) {
  return {
    _config: mergeConfig({ hitl: { pollIntervalMs: 1, timeoutMs: 200 } }),
    _client: { pollApproval },
  };
}

const TURN = { workflowId: 'wf-1', runId: 'run-1' };

describe('approval id guard', () => {
  it('waits on approval_id, else governance_event_id', () => {
    expect(awaitedApprovalId({ verdict: 'require_approval', approval_id: 'a-1', governance_event_id: 'g-1' })).toBe('a-1');
    expect(awaitedApprovalId({ verdict: 'require_approval', governance_event_id: 'g-1' })).toBe('g-1');
    expect(enforceVerdict({ verdict: 'require_approval', governance_event_id: 'g-1' }, 'tool_start').approvalId).toBe('g-1');
  });

  it('flags a decision for another approval, but not unknown ids', () => {
    expect(isDecisionForAnotherApproval({ id: 'old' }, 'new')).toBe(true);
    expect(isDecisionForAnotherApproval({ approval_id: 'new' }, 'new')).toBe(false);
    expect(isDecisionForAnotherApproval({}, 'new')).toBe(false);
    expect(isDecisionForAnotherApproval({ id: 'old' }, undefined)).toBe(false);
  });

  it('refuses an approval decided for another approval of the same activity', async () => {
    const pollApproval = vi.fn().mockResolvedValueOnce({ id: 'appr-old', verdict: 'allow' });
    const mw = makeMiddleware(pollApproval);
    await expect(pollApprovalOrHalt(mw as never, TURN, 'act-1', 'issueRefund', 'appr-new'))
      .rejects.toThrow(/appr-old instead of appr-new/);
  });

  it('keeps waiting through a pending answer for another approval', async () => {
    const pollApproval = vi
      .fn()
      .mockResolvedValueOnce({ id: 'appr-old', verdict: 'require_approval' })
      .mockResolvedValueOnce({ id: 'appr-new', verdict: 'allow' });
    const mw = makeMiddleware(pollApproval);
    await expect(pollApprovalOrHalt(mw as never, TURN, 'act-1', 'issueRefund', 'appr-new')).resolves.toBeUndefined();
    expect(pollApproval).toHaveBeenCalledTimes(2);
  });
});

describe('GovernanceClient.pollApproval', () => {
  it('always polls by workflow, run and activity', async () => {
    const request = vi.fn().mockResolvedValue(JSON.stringify({ verdict: 'require_approval' }));
    const ctx = {
      getCredentials: async () => ({ apiKey: 'obx_live_test' }),
      getNode: () => ({ name: 'OpenBox Agent' }),
      helpers: { httpRequest: request },
    };
    const client = new GovernanceClient(ctx as never, 'trace');
    await client.pollApproval('wf-1', 'run-1', 'act-1', 'appr-1');
    const body = JSON.parse((request.mock.calls[0][0].body as Buffer).toString('utf-8')) as Record<string, unknown>;
    expect(body).toEqual({ workflow_id: 'wf-1', run_id: 'run-1', activity_id: 'act-1' });
  });
});
