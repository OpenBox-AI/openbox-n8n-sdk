import type { OpenBoxLangChainMiddleware } from './middleware';
import { GovernanceHaltError, verdictFromString } from './verdict';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollApprovalOrHalt(
  mw: OpenBoxLangChainMiddleware,
  activityId: string,
  activityType: string,
): Promise<void> {
  if (!mw._config.hitl.enabled) {
    throw new GovernanceHaltError(`Approval required for activity ${activityType}`);
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt <= mw._config.hitl.timeoutMs) {
    const response = await mw._client.pollApproval(mw._workflowId, mw._runId, activityId);
    if (response == null) {
      await sleep(mw._config.hitl.pollIntervalMs);
      continue;
    }

    if (response.expired) {
      throw new GovernanceHaltError(
        `Approval expired for activity ${activityType} (workflow_id=${mw._workflowId}, run_id=${mw._runId}, activity_id=${activityId})`,
      );
    }

    const verdict = verdictFromString(response.verdict ?? response.action);
    if (verdict === 'allow') return;
    if (verdict === 'block' || verdict === 'halt') {
      throw new GovernanceHaltError(
        `Activity rejected: ${response.reason ?? 'Activity rejected'}`,
      );
    }

    await sleep(mw._config.hitl.pollIntervalMs);
  }

  throw new GovernanceHaltError(
    `Approval timed out for activity ${activityType} (workflow_id=${mw._workflowId}, run_id=${mw._runId}, activity_id=${activityId})`,
  );
}
