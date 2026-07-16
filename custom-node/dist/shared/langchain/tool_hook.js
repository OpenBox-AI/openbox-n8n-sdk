"use strict";
/* eslint-disable @n8n/community-nodes/require-node-api-error */
/**
 * Tool governance hook — TypeScript port of middleware_tool_hook.py.
 *
 * handle_wrap_tool_call: ToolStarted → execute tool → ToolCompleted.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleWrapToolCall = handleWrapToolCall;
const hooks_1 = require("./hooks");
const error_info_1 = require("./error-info");
const span_processor_1 = require("./span_processor");
const hitl_1 = require("./hitl");
const types_1 = require("./types");
const verdict_1 = require("./verdict");
async function handleWrapToolCall(mw, turn, toolName, toolArgs, handler) {
    // Skip governance for excluded tools (mirrors skip_tool_types config)
    if (mw._config.skipToolTypes.has(toolName)) {
        return handler();
    }
    const activityId = (0, types_1.hexId)(32);
    const toolType = mw._config.toolTypeMap[toolName];
    const startMs = Date.now();
    // ── ToolStarted ──────────────────────────────────────────────────────────────
    // registerActivity is called AFTER this evaluate (mirrors handleWrapModelCall).
    // Registering before the evaluate would put the activity in _activeActivities
    // while the HTTP request for the evaluate call fires — patchedFetch would then
    // capture that request as a hook span for the tool activity, sending a second
    // governance event to Core and creating a duplicate approval request.
    if (mw._config.sendToolStartEvent) {
        const response = await (0, hooks_1.evaluate)(mw, (0, hooks_1.buildEvent)(mw, turn, 'ToolStarted', activityId, toolName, {
            activity_input: [(0, types_1.safeSerialize)(toolArgs)],
            tool_name: toolName,
            tool_type: toolType,
        }));
        if (response != null) {
            try {
                const result = (0, verdict_1.enforceVerdict)(response, 'tool_start');
                if (result.requiresHitl) {
                    await (0, hitl_1.pollApprovalOrHalt)(mw, turn, activityId, toolName, result.approvalId);
                    (0, span_processor_1.markActivityApproved)(activityId);
                    (0, span_processor_1.clearActivityAbort)(activityId);
                }
            }
            catch (err) {
                // A hard block/halt at tool-start previously threw here with no
                // completion event sent at all — a true orphan on Core. Close it
                // with the same activity id before rethrowing.
                if (mw._config.sendToolEndEvent) {
                    await (0, hooks_1.sendOrphanClosure)(mw, turn, 'ToolCompleted', activityId, toolName, err);
                }
                throw err;
            }
        }
    }
    (0, span_processor_1.registerActivity)(activityId, {
        ...(0, hooks_1.baseEventFields)(mw, turn),
        event_type: 'ActivityStarted',
        activity_id: activityId,
        activity_type: toolName,
    }, mw._client.executeFunctions, turn.workflowId, { hitl: mw._config.hitl, onApiError: mw._config.onApiError, logger: mw._config.logger, requestTimeoutMs: mw._config.governanceTimeout * 1000 });
    // ── Execute tool ─────────────────────────────────────────────────────────────
    let toolResult;
    // Capture approval state before unregisterActivity clears it in the finally block.
    let wasApproved = false;
    try {
        while (true) {
            try {
                toolResult = await (0, span_processor_1.runWithActivity)(activityId, handler);
                // Some LangChain tools (e.g. Wikipedia) catch HTTP errors internally and
                // return them as strings rather than throwing. The hook still set the abort
                // flag before throwing — check it here so approval is triggered even when
                // the GovernanceBlockedError never propagated to this catch block.
                if ((0, span_processor_1.hasActivityAbort)(activityId)) {
                    await (0, hitl_1.pollApprovalOrHalt)(mw, turn, activityId, toolName);
                    (0, span_processor_1.markActivityApproved)(activityId);
                    (0, span_processor_1.clearActivityAbort)(activityId);
                    continue;
                }
                break;
            }
            catch (err) {
                const hookErr = err instanceof verdict_1.GovernanceBlockedError ? err : (0, hooks_1.extractGovernanceBlocked)(err);
                if (hookErr?.verdict === 'require_approval') {
                    await (0, hitl_1.pollApprovalOrHalt)(mw, turn, activityId, toolName);
                    (0, span_processor_1.markActivityApproved)(activityId);
                    (0, span_processor_1.clearActivityAbort)(activityId);
                    continue;
                }
                // A GovernanceHaltError/GovernanceBlockedError thrown inside the
                // patched fetch/http/db layer during tool execution can surface here
                // wrapped in whatever generic transport error the tool's own HTTP
                // client uses (e.g. a fetch-based client wrapping any thrown error as
                // a generic "connection error"), burying the real reason in `.cause`.
                // Prefer the reason recorded at the moment of the abort
                // (span_processor.ts's abortAndThrow) — reliable regardless of how
                // the client mangled the exception. Fall back to unwrapping the
                // caught error's cause chain, then to the raw error.
                const abortReasonText = (0, span_processor_1.getActivityAbortReason)(activityId);
                const failure = abortReasonText != null
                    ? new verdict_1.GovernanceHaltError(abortReasonText)
                    : (0, verdict_1.unwrapGovernanceError)(err) ?? err;
                const failEndMs = Date.now();
                if (mw._config.sendToolEndEvent && !(0, span_processor_1.isActivityApproved)(activityId)) {
                    await (0, hooks_1.evaluate)(mw, (0, hooks_1.buildEvent)(mw, turn, 'ToolCompleted', activityId, toolName, {
                        activity_output: (0, types_1.safeSerialize)({ error: (0, error_info_1.toErrorInfo)(failure) }),
                        tool_name: toolName,
                        tool_type: toolType,
                        status: 'failed',
                        duration_ms: failEndMs - startMs,
                        error: (0, error_info_1.toErrorInfo)(failure),
                    }));
                }
                throw failure;
            }
        }
        // Capture BEFORE finally runs — unregisterActivity clears _approvedActivities.
        wasApproved = (0, span_processor_1.isActivityApproved)(activityId);
    }
    finally {
        (0, span_processor_1.unregisterActivity)(activityId);
    }
    const endMs = Date.now();
    const duration_ms = endMs - startMs;
    // ── ToolCompleted ─────────────────────────────────────────────────────────────
    if (mw._config.sendToolEndEvent) {
        // String results wrapped as {result: ...}, non-strings serialized directly
        const serializedOutput = typeof toolResult === 'string'
            ? (0, types_1.safeSerialize)({ result: toolResult })
            : (0, types_1.safeSerialize)(toolResult);
        // Always send ToolCompleted so Core can show the completion on the dashboard.
        // Reuses the SAME activityId as ToolStarted — Core matches completions to
        // starts by activity_id; a different id produces an orphan Core discards.
        // When wasApproved=true (ToolStarted already required+received human approval),
        // send the event but skip verdict enforcement — enforcing it would trigger a
        // second governance evaluation and create a spurious approval row on Core.
        // Use wasApproved (captured before finally) because unregisterActivity already
        // cleared _approvedActivities by the time we reach here.
        const resp = await (0, hooks_1.evaluate)(mw, (0, hooks_1.buildEvent)(mw, turn, 'ToolCompleted', activityId, toolName, {
            activity_output: serializedOutput,
            tool_name: toolName,
            tool_type: toolType,
            status: 'completed',
            duration_ms,
        }));
        if (resp != null && !wasApproved) {
            const result = (0, verdict_1.enforceVerdict)(resp, 'tool_end');
            if (result.requiresHitl) {
                await (0, hitl_1.pollApprovalOrHalt)(mw, turn, activityId, toolName, result.approvalId);
            }
        }
    }
    return toolResult;
}
