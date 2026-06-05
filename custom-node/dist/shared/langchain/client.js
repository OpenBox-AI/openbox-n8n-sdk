"use strict";
/**
 * GovernanceClient — TypeScript port of openbox_langgraph/client.py.
 *
 * The Python SDK constructs its own httpx session; here we delegate to
 * openboxRequest() so requests are visible in n8n's execution UI and the
 * credential's signed headers are applied automatically.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GovernanceClient = void 0;
const openbox_client_1 = require("../openbox-client");
/**
 * Mirrors openbox_langgraph.types.to_server_event_type().
 *
 * The OpenBox Core API only accepts the Temporal SDK's canonical event
 * types (ActivityStarted, ActivityCompleted, WorkflowStarted, …).
 * LangChain-specific names (LLMStarted, ToolStarted, …) are SDK-internal
 * and must be translated before the request hits the wire.
 * The original name is preserved in `metadata.sdk_event_type` so the
 * dashboard can still distinguish LLM spans from generic activity spans.
 */
function toServerEventType(event) {
    const SDK_TO_SERVER = {
        LLMStarted: 'ActivityStarted',
        LLMCompleted: 'ActivityCompleted',
        ToolStarted: 'ActivityStarted',
        ToolCompleted: 'ActivityCompleted',
    };
    const serverType = SDK_TO_SERVER[event.event_type];
    if (!serverType)
        return event;
    return {
        ...event,
        event_type: serverType,
        // Preserve the SDK-level name so Core can group/tag accordingly.
        metadata: {
            ...(event.metadata ?? {}),
            sdk_event_type: event.event_type,
        },
    };
}
class GovernanceClient {
    traceId;
    // Exposed so span_processor can use the same IExecuteFunctions instance
    // for posting hook-level ActivityStarted events (mirrors Python's hook_governance
    // referencing the same httpx client as the main governance client).
    executeFunctions;
    constructor(executeFunctions, traceId) {
        this.executeFunctions = executeFunctions;
        this.traceId = traceId;
    }
    updateTraceId(traceId) {
        this.traceId = traceId;
    }
    /**
     * evaluate_event() — POST a governance event and return the verdict.
     * Returns null on soft failures (fail_open policy) so callers can
     * continue without governance rather than crashing the workflow.
     */
    async evaluateEvent(event) {
        try {
            return await (0, openbox_client_1.openboxRequest)(this.executeFunctions, {
                method: 'POST',
                path: '/api/v1/governance/evaluate',
                body: toServerEventType(event),
                noRetry: true,
                traceId: this.traceId,
            });
        }
        catch (err) {
            if (err instanceof openbox_client_1.SoftGovernanceError)
                return null;
            throw err;
        }
    }
    /**
     * poll_approval() — POST HITL poll payload to Core.
     * Mirrors openbox_langgraph.client.GovernanceClient.poll_approval().
     */
    async pollApproval(workflowId, runId, activityId, approvalId) {
        // If Core returned an approval_id in the evaluate response, use it as the
        // poll key (mirrors Python SDK's exc.action_id pattern). Otherwise fall
        // back to the triple (workflow_id, run_id, activity_id).
        const pollKey = approvalId ?? activityId;
        const reqBody = approvalId
            ? { workflow_id: pollKey, run_id: pollKey, activity_id: pollKey }
            : { workflow_id: workflowId, run_id: runId, activity_id: activityId };
        console.log('[OpenBox HITL] polling approval:', JSON.stringify(reqBody), approvalId ? `(using Core approvalId)` : `(using activityId)`);
        try {
            const data = await (0, openbox_client_1.openboxRequest)(this.executeFunctions, {
                method: 'POST',
                path: '/api/v1/governance/approval',
                body: reqBody,
                noRetry: true,
                traceId: this.traceId,
            });
            console.log('[OpenBox HITL] raw poll response:', JSON.stringify(data));
            const expiration = data.approval_expiration_time ?? data.approvalExpirationTime;
            if (typeof expiration === 'string' && expiration.trim()) {
                const expiresAt = Date.parse(expiration);
                if (!Number.isNaN(expiresAt) && expiresAt < Date.now()) {
                    console.log('[OpenBox HITL] approval expired at', expiration);
                    return { ...data, expired: true };
                }
            }
            return data;
        }
        catch (err) {
            if (err instanceof openbox_client_1.SoftGovernanceError)
                return null;
            throw err;
        }
    }
}
exports.GovernanceClient = GovernanceClient;
