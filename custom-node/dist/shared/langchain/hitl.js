"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pollApprovalOrHalt = pollApprovalOrHalt;
const verdict_1 = require("./verdict");
// Access setTimeout via global to avoid the no-restricted-globals ESLint rule.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _setTimeout = global.setTimeout;
function sleep(ms) {
    return new Promise((resolve) => _setTimeout(resolve, ms));
}
async function pollApprovalOrHalt(mw, activityId, activityType, approvalId) {
    if (!mw._config.hitl.enabled) {
        throw new verdict_1.GovernanceHaltError(`Approval required for activity ${activityType}`);
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt <= mw._config.hitl.timeoutMs) {
        const response = await mw._client.pollApproval(mw._workflowId, mw._runId, activityId, approvalId);
        if (response == null) {
            await sleep(mw._config.hitl.pollIntervalMs);
            continue;
        }
        if (response.expired) {
            throw new verdict_1.GovernanceHaltError(`Approval expired for activity ${activityType} (workflow_id=${mw._workflowId}, run_id=${mw._runId}, activity_id=${activityId})`);
        }
        const verdict = (0, verdict_1.verdictFromString)(response.arm ?? response.verdict ?? response.action);
        if (verdict === 'allow')
            return;
        if (verdict === 'block' || verdict === 'halt') {
            throw new verdict_1.GovernanceHaltError(`Activity rejected: ${response.reason ?? 'Activity rejected'}`);
        }
        await sleep(mw._config.hitl.pollIntervalMs);
    }
    throw new verdict_1.GovernanceHaltError(`Approval timed out for activity ${activityType} (workflow_id=${mw._workflowId}, run_id=${mw._runId}, activity_id=${activityId})`);
}
