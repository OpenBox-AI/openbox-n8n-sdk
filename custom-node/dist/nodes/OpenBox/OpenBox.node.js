"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OUTPUT_INDEX = exports.OpenBox = void 0;
exports.armToOutputIndex = armToOutputIndex;
exports.enforceVerdict = enforceVerdict;
exports.approvalStatusToOutputIndex = approvalStatusToOutputIndex;
exports.parseJsonParameter = parseJsonParameter;
exports.normalizeVerdict = normalizeVerdict;
const n8n_workflow_1 = require("n8n-workflow");
const openbox_client_1 = require("../../shared/openbox-client");
const credential_test_1 = require("../../shared/credential-test");
/**
 * Generic OpenBox governance node. Replaces the older 4-node + IF
 * pattern from the demo workflow with a single configurable node that
 * exposes every governance checkpoint as a Resource/Operation pair.
 *
 * Branchable verdict outputs (GAP-4) are NOT included here — that's
 * tracked separately. This node still throws on hard blocks, returns
 * a normalized verdict envelope on allows/constraints, and surfaces
 * approval IDs on `require_approval`. Callers can branch downstream
 * with an IF node on `verdict.arm` until GAP-4 lands.
 */
class OpenBox {
    description = {
        displayName: 'OpenBox',
        name: 'openBox',
        icon: 'file:OB_logomark.png',
        group: ['transform'],
        version: 1,
        subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
        description: 'Run an OpenBox governance checkpoint, request/poll approvals, emit audit events, or read a trust summary.',
        defaults: { name: 'OpenBox' },
        inputs: ['main'],
        // Six branchable outputs eliminate the need for downstream IF
        // nodes; users wire each verdict arm directly to the appropriate
        // follow-up. Order matches OUTPUT_INDEX below; n8n keys outputs
        // by position, not name, so this list MUST stay in sync with the
        // OUTPUT_INDEX constant. Names are mirrored in `outputNames` for
        // the editor labels.
        outputs: [
            { type: 'main', displayName: 'Allowed' },
            { type: 'main', displayName: 'Constrained' },
            { type: 'main', displayName: 'Approval Required' },
            { type: 'main', displayName: 'Blocked' },
            { type: 'main', displayName: 'Halted' },
            { type: 'main', displayName: 'Error' },
        ],
        credentials: [
            {
                name: 'openBoxApi',
                required: true,
                testedBy: 'openBoxApiCredentialTest',
            },
        ],
        properties: [
            // ────────────────────────────────────────────────────────────
            // Output routing — controls how verdicts map to the 6 outputs.
            // ────────────────────────────────────────────────────────────
            {
                displayName: 'On Block / Halt',
                name: 'onBlock',
                type: 'options',
                noDataExpression: true,
                options: [
                    {
                        name: 'Route to Output (recommended)',
                        value: 'route',
                        description: 'Send blocked / halted items to the matching output so the workflow can continue with a fallback branch.',
                    },
                    {
                        name: 'Throw Node Error',
                        value: 'throw',
                        description: 'Stop the node and fail the execution. Use when downstream steps must NEVER run on a block.',
                    },
                ],
                default: 'route',
            },
            // ────────────────────────────────────────────────────────────
            // Resource / Operation
            // ────────────────────────────────────────────────────────────
            {
                displayName: 'Resource',
                name: 'resource',
                type: 'options',
                noDataExpression: true,
                options: [
                    { name: 'Governance', value: 'governance' },
                    { name: 'Approval', value: 'approval' },
                    { name: 'Audit', value: 'audit' },
                    { name: 'Trust', value: 'trust' },
                ],
                default: 'governance',
            },
            // Governance operations
            {
                displayName: 'Operation',
                name: 'operation',
                type: 'options',
                noDataExpression: true,
                displayOptions: { show: { resource: ['governance'] } },
                options: [
                    {
                        name: 'Evaluate Event',
                        value: 'evaluate',
                        action: 'Evaluate a governance event',
                        description: 'Send a fully-formed event payload to OpenBox and return the verdict.',
                    },
                    {
                        name: 'Authorize Action',
                        value: 'authorize',
                        action: 'Authorize an action before it runs',
                        description: 'Pre-execution check (ActivityStarted) — blocks before the action runs.',
                    },
                    {
                        name: 'Monitor Node',
                        value: 'monitor',
                        action: 'Emit a non-blocking monitoring event',
                        description: 'Fire-and-forget telemetry; verdict is treated as advisory.',
                    },
                    {
                        name: 'Verify Output',
                        value: 'verify',
                        action: 'Verify an action s output',
                        description: 'Post-execution check (ActivityCompleted) — blocks the output if violated.',
                    },
                ],
                default: 'evaluate',
            },
            // Approval operations
            {
                displayName: 'Operation',
                name: 'operation',
                type: 'options',
                noDataExpression: true,
                displayOptions: { show: { resource: ['approval'] } },
                options: [
                    {
                        name: 'Request Approval',
                        value: 'request',
                        action: 'Request a human approval',
                        description: 'Trigger an approval flow by emitting a require-approval governance event.',
                    },
                    {
                        name: 'Poll Approval',
                        value: 'poll',
                        action: 'Poll an approval until it resolves',
                        description: 'Block until the approval is approved/denied or the wait limit is hit.',
                    },
                ],
                default: 'request',
            },
            // Audit operations
            {
                displayName: 'Operation',
                name: 'operation',
                type: 'options',
                noDataExpression: true,
                displayOptions: { show: { resource: ['audit'] } },
                options: [
                    {
                        name: 'Emit Audit Event',
                        value: 'emit',
                        action: 'Emit an audit log event',
                        description: 'Send an immutable audit record; never blocks the workflow.',
                    },
                ],
                default: 'emit',
            },
            // Trust operations
            {
                displayName: 'Operation',
                name: 'operation',
                type: 'options',
                noDataExpression: true,
                displayOptions: { show: { resource: ['trust'] } },
                options: [
                    {
                        name: 'Get Trust Summary',
                        value: 'getSummary',
                        action: 'Get the trust summary for an agent',
                        description: 'Read the current trust tier and recent risk score for an agent.',
                    },
                ],
                default: 'getSummary',
            },
            // ────────────────────────────────────────────────────────────
            // Common workflow correlation fields (governance + audit)
            // ────────────────────────────────────────────────────────────
            {
                displayName: 'Workflow Type',
                name: 'workflowType',
                type: 'string',
                default: '={{$workflow.name}}',
                displayOptions: {
                    show: {
                        resource: ['governance', 'audit'],
                    },
                },
                description: 'Logical workflow identifier shown on the OpenBox dashboard. Defaults to the n8n workflow name.',
            },
            {
                displayName: 'Workflow ID',
                name: 'workflowId',
                type: 'string',
                default: '={{$workflow.id + "-" + $execution.id}}',
                displayOptions: {
                    show: {
                        resource: ['governance', 'audit'],
                    },
                },
                description: 'Unique workflow run identifier. Defaults to the n8n workflow ID plus execution ID for cross-node correlation.',
            },
            {
                displayName: 'Activity Type',
                name: 'activityType',
                type: 'string',
                default: '={{$node.name}}',
                displayOptions: {
                    show: {
                        resource: ['governance'],
                        operation: ['authorize', 'monitor', 'verify'],
                    },
                },
                description: 'Identifier for the action being governed. Defaults to the current node name.',
            },
            // ────────────────────────────────────────────────────────────
            // Governance > Evaluate (advanced raw event payload)
            // ────────────────────────────────────────────────────────────
            {
                displayName: 'Event Type',
                name: 'eventType',
                type: 'options',
                displayOptions: {
                    show: {
                        resource: ['governance'],
                        operation: ['evaluate'],
                    },
                },
                options: [
                    { name: 'Workflow Started', value: 'WorkflowStarted' },
                    { name: 'Workflow Completed', value: 'WorkflowCompleted' },
                    { name: 'Workflow Failed', value: 'WorkflowFailed' },
                    { name: 'Activity Started', value: 'ActivityStarted' },
                    { name: 'Activity Completed', value: 'ActivityCompleted' },
                ],
                default: 'ActivityStarted',
            },
            {
                displayName: 'Activity Type',
                name: 'activityTypeRaw',
                type: 'string',
                default: '={{$node.name}}',
                displayOptions: {
                    show: {
                        resource: ['governance'],
                        operation: ['evaluate'],
                        eventType: ['ActivityStarted', 'ActivityCompleted'],
                    },
                },
            },
            // ────────────────────────────────────────────────────────────
            // Payload (input / output) — shared by evaluate/authorize/verify
            // ────────────────────────────────────────────────────────────
            {
                displayName: 'Input Payload',
                name: 'inputPayload',
                type: 'json',
                default: '={{ [$json] }}',
                displayOptions: {
                    show: {
                        resource: ['governance'],
                        operation: ['evaluate', 'authorize', 'monitor', 'verify'],
                    },
                },
                description: 'JSON array of input items submitted to OpenBox for evaluation. Defaults to a single-element array containing the current item.',
            },
            {
                displayName: 'Output Payload',
                name: 'outputPayload',
                type: 'json',
                default: '={{ $json }}',
                displayOptions: {
                    show: {
                        resource: ['governance'],
                        operation: ['evaluate', 'verify'],
                    },
                },
                description: 'Output JSON to be governed. Required for "Verify Output".',
            },
            // ────────────────────────────────────────────────────────────
            // Approval > Request
            // ────────────────────────────────────────────────────────────
            {
                displayName: 'Workflow Type',
                name: 'approvalWorkflowType',
                type: 'string',
                default: '={{$workflow.name}}',
                displayOptions: {
                    show: {
                        resource: ['approval'],
                        operation: ['request'],
                    },
                },
            },
            {
                displayName: 'Workflow ID',
                name: 'approvalWorkflowId',
                type: 'string',
                default: '={{$workflow.id + "-" + $execution.id}}',
                displayOptions: {
                    show: {
                        resource: ['approval'],
                        operation: ['request'],
                    },
                },
            },
            {
                displayName: 'Activity Type',
                name: 'approvalActivityType',
                type: 'string',
                default: '={{$node.name}}',
                displayOptions: {
                    show: {
                        resource: ['approval'],
                        operation: ['request'],
                    },
                },
            },
            {
                displayName: 'Reason',
                name: 'approvalReason',
                type: 'string',
                default: '',
                placeholder: 'Why human review is being requested',
                displayOptions: {
                    show: {
                        resource: ['approval'],
                        operation: ['request'],
                    },
                },
            },
            {
                displayName: 'Context',
                name: 'approvalContext',
                type: 'json',
                default: '={{ $json }}',
                displayOptions: {
                    show: {
                        resource: ['approval'],
                        operation: ['request'],
                    },
                },
                description: 'Free-form JSON that approvers will see in the OpenBox console.',
            },
            // ────────────────────────────────────────────────────────────
            // Approval > Poll
            // ────────────────────────────────────────────────────────────
            {
                displayName: 'Approval ID',
                name: 'approvalId',
                type: 'string',
                default: '',
                required: true,
                displayOptions: {
                    show: {
                        resource: ['approval'],
                        operation: ['poll'],
                    },
                },
            },
            {
                displayName: 'Wait Until Resolved',
                name: 'waitForResolution',
                type: 'boolean',
                default: true,
                displayOptions: {
                    show: {
                        resource: ['approval'],
                        operation: ['poll'],
                    },
                },
                description: 'If true, the node blocks the workflow until the approval reaches a terminal state or the max wait elapses.',
            },
            {
                displayName: 'Polling Interval (ms)',
                name: 'pollIntervalMs',
                type: 'number',
                typeOptions: { minValue: 250, maxValue: 60000 },
                default: 2000,
                displayOptions: {
                    show: {
                        resource: ['approval'],
                        operation: ['poll'],
                        waitForResolution: [true],
                    },
                },
            },
            {
                displayName: 'Max Wait (ms)',
                name: 'maxWaitMs',
                type: 'number',
                typeOptions: { minValue: 1000 },
                default: 600000,
                displayOptions: {
                    show: {
                        resource: ['approval'],
                        operation: ['poll'],
                        waitForResolution: [true],
                    },
                },
                description: 'Maximum total wait time. Default is 10 minutes.',
            },
            // ────────────────────────────────────────────────────────────
            // Audit > Emit
            // ────────────────────────────────────────────────────────────
            {
                displayName: 'Audit Event',
                name: 'auditEvent',
                type: 'string',
                default: '',
                required: true,
                placeholder: 'tool.invoked',
                displayOptions: {
                    show: {
                        resource: ['audit'],
                        operation: ['emit'],
                    },
                },
            },
            {
                displayName: 'Audit Severity',
                name: 'auditSeverity',
                type: 'options',
                options: [
                    { name: 'Info', value: 'info' },
                    { name: 'Warning', value: 'warning' },
                    { name: 'Error', value: 'error' },
                    { name: 'Critical', value: 'critical' },
                ],
                default: 'info',
                displayOptions: {
                    show: {
                        resource: ['audit'],
                        operation: ['emit'],
                    },
                },
            },
            {
                displayName: 'Audit Payload',
                name: 'auditPayload',
                type: 'json',
                default: '={{ $json }}',
                displayOptions: {
                    show: {
                        resource: ['audit'],
                        operation: ['emit'],
                    },
                },
            },
            // ────────────────────────────────────────────────────────────
            // Trust > Get Summary
            // ────────────────────────────────────────────────────────────
            {
                displayName: 'Agent ID',
                name: 'trustAgentId',
                type: 'string',
                default: '',
                required: true,
                displayOptions: {
                    show: {
                        resource: ['trust'],
                        operation: ['getSummary'],
                    },
                },
                description: 'OpenBox agent ID whose trust tier should be returned.',
            },
        ],
    };
    methods = {
        credentialTest: {
            openBoxApiCredentialTest: credential_test_1.testOpenBoxCredential,
        },
    };
    async execute() {
        const items = this.getInputData();
        // Six output buckets, indexed by OUTPUT_INDEX. Build them up
        // front so a partial run still returns a valid 2D array even if
        // every input item routes to the same output.
        const buckets = [[], [], [], [], [], []];
        const onBlock = this.getNodeParameter('onBlock', 0, 'route');
        for (let i = 0; i < items.length; i++) {
            try {
                const resource = this.getNodeParameter('resource', i);
                let result;
                switch (resource) {
                    case 'governance':
                        result = await runGovernance.call(this, i);
                        break;
                    case 'approval':
                        result = await runApproval.call(this, i);
                        break;
                    case 'audit':
                        result = await runAudit.call(this, i);
                        break;
                    case 'trust':
                        result = await runTrust.call(this, i);
                        break;
                    default: {
                        const exhaustive = resource;
                        throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Unsupported OpenBox resource: ${exhaustive}`, { itemIndex: i });
                    }
                }
                // Hard-fail mode: surface block/halt as an exception so the
                // n8n execution stops with a clear error. The PRD's default
                // is the routing path, but legacy workflows that wired up
                // `continueOnFail` rely on this branch.
                if (onBlock === 'throw' &&
                    (result.outputIndex === exports.OUTPUT_INDEX.BLOCKED ||
                        result.outputIndex === exports.OUTPUT_INDEX.HALTED)) {
                    const arm = result.outputIndex === exports.OUTPUT_INDEX.HALTED ? 'halt' : 'block';
                    throw new n8n_workflow_1.NodeOperationError(this.getNode(), `OpenBox ${arm}: ${result.output.reason ?? 'no reason provided'}`, { itemIndex: i, description: JSON.stringify(result.output) });
                }
                buckets[result.outputIndex].push({
                    json: { ...items[i].json, _openbox: result.output },
                    pairedItem: { item: i },
                });
            }
            catch (err) {
                // Soft governance failures (fail_open) and continueOnFail
                // errors both land here. They route to the dedicated Error
                // output so the workflow can recover; the original error is
                // preserved on the item so downstream nodes can read it.
                if (this.continueOnFail() || err instanceof openbox_client_1.SoftGovernanceError) {
                    const message = err instanceof Error ? err.message : String(err);
                    buckets[exports.OUTPUT_INDEX.ERROR].push({
                        json: { ...items[i].json, _openbox: { error: message } },
                        error: err instanceof Error ? err : undefined,
                        pairedItem: { item: i },
                    });
                    continue;
                }
                throw err;
            }
        }
        return buckets;
    }
}
exports.OpenBox = OpenBox;
// ────────────────────────────────────────────────────────────────────
// Output routing
// ────────────────────────────────────────────────────────────────────
/**
 * Position of each named output in the `outputs` array. Mirrored by
 * the descriptor above; n8n keys outputs by index, so changing one
 * without the other will silently misroute verdicts.
 */
/** Exported for unit tests. */
exports.OUTPUT_INDEX = {
    ALLOWED: 0,
    CONSTRAINED: 1,
    APPROVAL_REQUIRED: 2,
    BLOCKED: 3,
    HALTED: 4,
    ERROR: 5,
};
/** Map a verdict arm to its output index. Exported for unit tests. */
function armToOutputIndex(arm) {
    switch (arm) {
        case 'allow':
            return exports.OUTPUT_INDEX.ALLOWED;
        case 'constrain':
            return exports.OUTPUT_INDEX.CONSTRAINED;
        case 'require_approval':
            return exports.OUTPUT_INDEX.APPROVAL_REQUIRED;
        case 'block':
            return exports.OUTPUT_INDEX.BLOCKED;
        case 'halt':
            return exports.OUTPUT_INDEX.HALTED;
        default:
            return exports.OUTPUT_INDEX.ERROR;
    }
}
/**
 * Enforce a verdict with the correct priority chain, matching
 * verdict_handler.py enforce_verdict():
 *   halt > block > guardrails_failed > require_approval > constrain > allow
 *
 * Returns the output bucket index. Does NOT throw — callers decide
 * whether to throw or route based on onBlock.
 */
function enforceVerdict(verdict) {
    if (verdict.arm === 'halt')
        return exports.OUTPUT_INDEX.HALTED;
    if (verdict.arm === 'block')
        return exports.OUTPUT_INDEX.BLOCKED;
    const gr = verdict.guardrails_result ?? verdict.guardrailsResult;
    if (gr && gr.validation_passed === false)
        return exports.OUTPUT_INDEX.BLOCKED;
    if (verdict.arm === 'require_approval')
        return exports.OUTPUT_INDEX.APPROVAL_REQUIRED;
    if (verdict.arm === 'constrain')
        return exports.OUTPUT_INDEX.CONSTRAINED;
    return exports.OUTPUT_INDEX.ALLOWED;
}
// ────────────────────────────────────────────────────────────────────
// Resource handlers
// ────────────────────────────────────────────────────────────────────
async function runGovernance(itemIndex) {
    const operation = this.getNodeParameter('operation', itemIndex);
    const workflowType = String(this.getNodeParameter('workflowType', itemIndex, this.getWorkflow().name ?? 'n8n'));
    const workflowId = String(this.getNodeParameter('workflowId', itemIndex, `${this.getWorkflow().id}-${this.getExecutionId()}`));
    const baseRequest = {
        source: 'workflow-telemetry',
        timestamp: new Date().toISOString(),
        workflow_id: workflowId,
        run_id: this.getExecutionId(),
        workflow_type: workflowType,
        task_queue: 'n8n',
    };
    let request;
    switch (operation) {
        case 'evaluate': {
            const eventType = this.getNodeParameter('eventType', itemIndex, 'ActivityStarted');
            const activityType = this.getNodeParameter('activityTypeRaw', itemIndex, this.getNode().name);
            request = {
                ...baseRequest,
                event_type: eventType,
                activity_type: eventType === 'ActivityStarted' || eventType === 'ActivityCompleted'
                    ? activityType
                    : undefined,
                activity_stage: eventType === 'ActivityCompleted' ? 'post' : 'pre',
                payload: extractGovernancePayload(this, itemIndex, { input: true, output: true }),
            };
            break;
        }
        case 'authorize': {
            request = {
                ...baseRequest,
                event_type: 'ActivityStarted',
                activity_type: this.getNodeParameter('activityType', itemIndex, this.getNode().name),
                activity_stage: 'pre',
                payload: extractGovernancePayload(this, itemIndex, { input: true, output: false }),
            };
            break;
        }
        case 'verify': {
            request = {
                ...baseRequest,
                event_type: 'ActivityCompleted',
                activity_type: this.getNodeParameter('activityType', itemIndex, this.getNode().name),
                activity_stage: 'post',
                payload: extractGovernancePayload(this, itemIndex, { input: true, output: true }),
            };
            break;
        }
        case 'monitor': {
            request = {
                ...baseRequest,
                event_type: 'ActivityStarted',
                activity_type: this.getNodeParameter('activityType', itemIndex, this.getNode().name),
                activity_stage: 'pre',
                payload: extractGovernancePayload(this, itemIndex, { input: true, output: false }),
                metadata: { advisory: true },
            };
            break;
        }
        default: {
            const exhaustive = operation;
            throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Unsupported governance operation: ${exhaustive}`, { itemIndex });
        }
    }
    let verdict;
    try {
        verdict = await (0, openbox_client_1.openboxRequest)(this, {
            method: 'POST',
            path: '/api/v1/governance/evaluate',
            body: request,
            noRetry: true,
            traceId: workflowId,
        });
    }
    catch (err) {
        if (operation === 'monitor' && err instanceof openbox_client_1.SoftGovernanceError) {
            // Monitoring is best-effort: a transient OpenBox outage should
            // never break a Monitor checkpoint. Surface the failure on the
            // Allowed branch with an `advisory` flag so observers can
            // distinguish it from a real allow.
            return {
                output: { advisory: true, error: err.message },
                outputIndex: exports.OUTPUT_INDEX.ALLOWED,
            };
        }
        throw err;
    }
    const normalized = normalizeVerdict(verdict);
    if (operation === 'monitor') {
        return {
            output: { ...normalized, advisory: true },
            outputIndex: exports.OUTPUT_INDEX.ALLOWED,
        };
    }
    return { output: normalized, outputIndex: enforceVerdict(verdict) };
}
async function runApproval(itemIndex) {
    const operation = this.getNodeParameter('operation', itemIndex);
    if (operation === 'request') {
        const workflowType = String(this.getNodeParameter('approvalWorkflowType', itemIndex, this.getWorkflow().name ?? 'n8n'));
        const workflowId = String(this.getNodeParameter('approvalWorkflowId', itemIndex, `${this.getWorkflow().id}-${this.getExecutionId()}`));
        const activityType = String(this.getNodeParameter('approvalActivityType', itemIndex, this.getNode().name));
        const reason = String(this.getNodeParameter('approvalReason', itemIndex, ''));
        const context = parseJsonParameter(this.getNodeParameter('approvalContext', itemIndex, {}));
        const verdict = await (0, openbox_client_1.openboxRequest)(this, {
            method: 'POST',
            path: '/api/v1/governance/evaluate',
            body: {
                workflow_id: workflowId,
                run_id: this.getExecutionId(),
                workflow_type: workflowType,
                task_queue: 'n8n',
                source: 'workflow-telemetry',
                timestamp: new Date().toISOString(),
                event_type: 'ActivityStarted',
                activity_type: activityType,
                activity_stage: 'pre',
                payload: { input: [{ context }] },
                metadata: {
                    approval_request: true,
                    reason,
                },
            },
            noRetry: true,
            traceId: workflowId,
        });
        const normalized = normalizeVerdict(verdict);
        return { output: normalized, outputIndex: armToOutputIndex(verdict.arm) };
    }
    // Poll
    const approvalId = String(this.getNodeParameter('approvalId', itemIndex, '')).trim();
    if (!approvalId) {
        throw new n8n_workflow_1.NodeOperationError(this.getNode(), 'Approval ID is required to poll.', {
            itemIndex,
        });
    }
    const waitForResolution = this.getNodeParameter('waitForResolution', itemIndex, true);
    const pollIntervalMs = this.getNodeParameter('pollIntervalMs', itemIndex, 2000);
    const maxWaitMs = this.getNodeParameter('maxWaitMs', itemIndex, 600_000);
    let deadline = Date.now() + Math.max(0, maxWaitMs);
    let lastResponse;
    while (true) {
        lastResponse = await (0, openbox_client_1.openboxRequest)(this, {
            method: 'POST',
            path: '/api/v1/governance/approval',
            body: { approval_id: approvalId },
        });
        // F18: honour approval_expiration_time from the API response so
        // the polling loop exits as soon as the server-side expiry passes,
        // rather than waiting until maxWaitMs elapses.
        const expirationRaw = lastResponse.approval_expiration_time ?? lastResponse.expires_at;
        if (expirationRaw) {
            const expiresMs = new Date(String(expirationRaw)).getTime();
            if (!Number.isNaN(expiresMs) && expiresMs < deadline) {
                deadline = expiresMs;
            }
        }
        const status = String(lastResponse.status ?? lastResponse.state ?? '').toLowerCase();
        const terminal = status === 'approved' ||
            status === 'denied' ||
            status === 'rejected' ||
            status === 'expired' ||
            status === 'timeout' ||
            status === 'cancelled' ||
            status === 'canceled';
        if (terminal || !waitForResolution) {
            return {
                output: { approvalId, ...lastResponse },
                outputIndex: approvalStatusToOutputIndex(status),
            };
        }
        if (Date.now() >= deadline) {
            throw new n8n_workflow_1.NodeApiError(this.getNode(), {
                message: `Approval ${approvalId} did not resolve within ${maxWaitMs}ms`,
                description: JSON.stringify(lastResponse),
            });
        }
        await sleep(Math.max(250, Math.min(pollIntervalMs, deadline - Date.now())));
    }
}
async function runAudit(itemIndex) {
    const event = String(this.getNodeParameter('auditEvent', itemIndex, '')).trim();
    if (!event) {
        throw new n8n_workflow_1.NodeOperationError(this.getNode(), 'Audit event name is required.', {
            itemIndex,
        });
    }
    const severity = this.getNodeParameter('auditSeverity', itemIndex, 'info');
    const payload = parseJsonParameter(this.getNodeParameter('auditPayload', itemIndex, {}));
    const workflowType = String(this.getNodeParameter('workflowType', itemIndex, this.getWorkflow().name ?? 'n8n'));
    const workflowId = String(this.getNodeParameter('workflowId', itemIndex, `${this.getWorkflow().id}-${this.getExecutionId()}`));
    await (0, openbox_client_1.openboxRequest)(this, {
        method: 'POST',
        path: '/api/v1/governance/evaluate',
        body: {
            workflow_id: workflowId,
            run_id: this.getExecutionId(),
            workflow_type: workflowType,
            task_queue: 'n8n',
            source: 'workflow-telemetry',
            timestamp: new Date().toISOString(),
            event_type: 'AuditLog',
            activity_type: event,
            activity_stage: 'post',
            payload: { input: [payload] },
            metadata: { audit: true, severity },
        },
    });
    return {
        output: { audited: true, event, severity },
        outputIndex: exports.OUTPUT_INDEX.ALLOWED,
    };
}
async function runTrust(itemIndex) {
    const agentId = String(this.getNodeParameter('trustAgentId', itemIndex, '')).trim();
    if (!agentId) {
        throw new n8n_workflow_1.NodeOperationError(this.getNode(), 'Agent ID is required.', { itemIndex });
    }
    const summary = await (0, openbox_client_1.openboxRequest)(this, {
        method: 'GET',
        path: `/api/v1/agents/${encodeURIComponent(agentId)}/trust`,
    });
    return { output: { trust: summary }, outputIndex: exports.OUTPUT_INDEX.ALLOWED };
}
/**
 * Map an approval-poll terminal/in-progress status string to the
 * appropriate verdict output. Approved goes to Allowed; the various
 * terminal denial states all land on Blocked so users can wire a
 * single fallback branch. Anything still in-flight (only reachable
 * when the user disabled wait-for-resolution) goes to
 * Approval Required.
 */
/** Exported for unit tests. */
function approvalStatusToOutputIndex(status) {
    switch (status) {
        case 'approved':
            return exports.OUTPUT_INDEX.ALLOWED;
        case 'denied':
        case 'rejected':
        case 'expired':
        case 'timeout':
        case 'cancelled':
        case 'canceled':
            return exports.OUTPUT_INDEX.BLOCKED;
        default:
            return exports.OUTPUT_INDEX.APPROVAL_REQUIRED;
    }
}
// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────
function extractGovernancePayload(ctx, itemIndex, flags) {
    const payload = {};
    if (flags.input) {
        const raw = ctx.getNodeParameter('inputPayload', itemIndex, []);
        const parsed = parseJsonParameter(raw);
        payload.input = Array.isArray(parsed) ? parsed : [parsed];
    }
    if (flags.output) {
        const raw = ctx.getNodeParameter('outputPayload', itemIndex, undefined);
        if (raw !== undefined && raw !== null && raw !== '') {
            payload.output = parseJsonParameter(raw);
        }
    }
    return payload;
}
/** Exported for unit tests. */
function parseJsonParameter(value) {
    if (typeof value !== 'string')
        return value;
    const trimmed = value.trim();
    if (!trimmed)
        return undefined;
    try {
        return JSON.parse(trimmed);
    }
    catch {
        // Allow free-form strings to flow through as-is so users can pass
        // bare values without quoting them as JSON.
        return value;
    }
}
/** Exported for unit tests. */
function normalizeVerdict(verdict) {
    const gr = verdict.guardrailsResult ?? verdict.guardrails_result;
    return {
        arm: verdict.arm,
        approvalId: verdict.approvalId ?? verdict.approval_id,
        governanceEventId: verdict.governanceEventId ?? verdict.governance_event_id,
        reason: verdict.reason,
        riskScore: verdict.riskScore ?? verdict.risk_score,
        trustTier: verdict.trustTier ?? verdict.trust_tier,
        guardrailsResult: gr,
    };
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
