"use strict";
/* eslint-disable @n8n/community-nodes/require-node-api-error */
/**
 * Hook handler functions — TypeScript port of middleware_hook_handlers.py.
 *
 * handle_before_agent / handle_after_agent / handle_wrap_model_call.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleBeforeAgent = handleBeforeAgent;
exports.handleAfterAgent = handleAfterAgent;
exports.handleWrapModelCall = handleWrapModelCall;
exports.handleWrapMemoryOp = handleWrapMemoryOp;
const hooks_1 = require("./hooks");
const error_info_1 = require("./error-info");
const hitl_1 = require("./hitl");
const span_processor_1 = require("./span_processor");
const openbox_client_1 = require("../openbox-client");
const types_1 = require("./types");
const verdict_1 = require("./verdict");
// ═══════════════════════════════════════════════════════════════════
// handle_before_agent → WorkflowStarted + SignalReceived (enforced)
// ═══════════════════════════════════════════════════════════════════
async function handleBeforeAgent(mw, state, threadId = 'n8n') {
    const minted = (0, types_1.hexId)(32);
    const turn = {
        workflowId: `${threadId}-${minted.slice(0, 8)}`,
        runId: `${threadId}-run-${minted.slice(8, 16)}`,
    };
    mw._client.updateTraceId(turn.workflowId);
    // The constructor adds the default OpenBox URL to _ignoredPrefixes, but the
    // actual URL for requests comes from the n8n credential (openboxUrl), which
    // may differ (e.g. a self-hosted Core). Ensure it is ignored so HTTP calls
    // to Core made while a tool activity is registered don't get intercepted as
    // hook spans and sent back to Core a second time, creating duplicate
    // approval requests.
    try {
        const creds = await (0, openbox_client_1.getOpenBoxCredentials)(mw._client.executeFunctions);
        (0, span_processor_1.addIgnoredPrefix)(creds.openboxUrl);
    }
    catch { /* non-fatal — constructor already added the default URL */ }
    const messages = state.messages ?? [];
    // Everything below can throw (governance block/halt, or a hard API-error
    // failure now that auth/onApiError=fail_closed propagate instead of
    // silently swallowing). turn is minted above and never depends on any of
    // this succeeding, so attach it to any thrown error — the caller
    // (OpenBoxAgent.node.ts) needs it to still call afterAgent()/close the
    // workflow even when beforeAgent itself fails.
    try {
        // WorkflowStarted — identity only. Sent before SignalReceived so Core's
        // event ordering matches actual execution order.
        if (mw._config.sendChainStartEvent) {
            await (0, hooks_1.evaluate)(mw, (0, hooks_1.buildEvent)(mw, turn, 'WorkflowStarted', `${turn.runId}-wf`, mw._workflowType));
        }
        // SignalReceived — user prompt as trigger. Governed whenever there is a
        // human/user turn at all, regardless of whether the extracted text is
        // empty or multimodal — an empty/non-text first turn must still be
        // governed, not silently skipped.
        if ((0, hooks_1.hasHumanTurn)(messages)) {
            const userPrompt = (0, hooks_1.extractLastUserMessage)(messages) ?? '';
            const sigActivityId = `${turn.runId}-sig`;
            const response = await (0, hooks_1.evaluate)(mw, (0, hooks_1.buildEvent)(mw, turn, 'SignalReceived', sigActivityId, 'user_prompt', {
                signal_name: 'user_prompt',
                signal_args: [userPrompt],
            }));
            if (response != null) {
                try {
                    const result = (0, verdict_1.enforceVerdict)(response, 'signal_received');
                    if (result.requiresHitl) {
                        await (0, hitl_1.pollApprovalOrHalt)(mw, turn, sigActivityId, 'user_prompt', result.approvalId);
                    }
                }
                catch (err) {
                    await (0, hooks_1.sendOrphanClosure)(mw, turn, 'ActivityCompleted', sigActivityId, 'user_prompt', err);
                    throw err;
                }
            }
        }
        // LLMStarted pre-screen is intentionally deferred to handleWrapModelCall.
        // Sending LLMStarted here (before memory_load) would anchor the llm_call
        // activity to the before_agent timestamp, causing Core to display it before
        // the memory_load activity even though the model call happens after.
        // wrapModelCall sends LLMStarted at the correct time (after memory is loaded),
        // so all events arrive at Core in true execution order.
        return turn;
    }
    catch (err) {
        if (err != null && typeof err === 'object') {
            err.__obTurn = turn;
        }
        throw err;
    }
}
// ═══════════════════════════════════════════════════════════════════
// handle_after_agent → WorkflowCompleted
// ═══════════════════════════════════════════════════════════════════
async function handleAfterAgent(mw, turn, state, failedWith) {
    if (!mw._config.sendChainEndEvent)
        return null;
    const messages = state.messages ?? [];
    let lastContent = null;
    if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        lastContent = lastMsg?.content ?? null;
    }
    const verdict = await (0, hooks_1.evaluate)(mw, (0, hooks_1.buildEvent)(mw, turn, 'WorkflowCompleted', `${turn.runId}-wf`, mw._workflowType, {
        workflow_output: (0, types_1.safeSerialize)({ result: lastContent }),
        status: failedWith ? 'failed' : 'completed',
        ...(failedWith ? { error: (0, error_info_1.toErrorInfo)(failedWith) } : {}),
    }));
    // Clean up any lingering activity registrations for this workflow.
    // Mirrors Python SDK's span_processor.unregister_workflow(workflow_id).
    (0, span_processor_1.unregisterWorkflow)(turn.workflowId);
    return verdict;
}
// ═══════════════════════════════════════════════════════════════════
// handle_wrap_model_call → LLMStarted → PII redact → Model → LLMCompleted
// ═══════════════════════════════════════════════════════════════════
async function handleWrapModelCall(mw, turn, messages, handler) {
    // Use only the last human message as the governed prompt — extractPromptFromMessages
    // would join ALL human messages including chat history loaded from memory, producing
    // a concatenated blob of prior turns instead of the current user input.
    const promptText = (0, hooks_1.extractLastUserMessage)(messages) ?? (0, hooks_1.extractPromptFromMessages)(messages);
    const activityId = (0, types_1.hexId)(32);
    let startResponse;
    const startMs = Date.now();
    if (mw._config.sendLlmStartEvent) {
        startResponse = await (0, hooks_1.evaluate)(mw, (0, hooks_1.buildEvent)(mw, turn, 'LLMStarted', activityId, 'llm_call', {
            activity_input: [{ prompt: promptText }],
            prompt: promptText,
        }));
    }
    else {
        startResponse = null;
    }
    // PII redaction — only apply when the returned text is a valid, non-null
    // coercion of Core's redacted_input. Redaction removes/replaces content; it
    // never expands it arbitrarily, so no length heuristic is applied here —
    // that heuristic previously caused legitimate (longer) redactions to be
    // silently skipped, leaking the raw prompt to the model provider.
    const guardrails = startResponse?.guardrails_result ?? startResponse?.guardrailsResult;
    if (guardrails?.input_type === 'activity_input' && guardrails.redacted_input != null) {
        (0, hooks_1.applyPiiRedaction)(messages, guardrails.redacted_input);
    }
    // Enforce LLMStarted verdict (block/halt throw; require_approval polls).
    // On a hard block/halt, close the orphaned llm_call row before rethrowing —
    // otherwise it's a "started, never completed" row on Core forever.
    if (startResponse != null) {
        try {
            const result = (0, verdict_1.enforceVerdict)(startResponse, 'llm_start');
            if (result.requiresHitl) {
                await (0, hitl_1.pollApprovalOrHalt)(mw, turn, activityId, 'llm_call', result.approvalId);
                (0, span_processor_1.markActivityApproved)(activityId);
            }
        }
        catch (err) {
            if (mw._config.sendLlmEndEvent) {
                await (0, hooks_1.sendOrphanClosure)(mw, turn, 'LLMCompleted', activityId, 'llm_call', err);
            }
            throw err;
        }
    }
    // ── Layer 2: HTTP span collector (mirrors Python's WorkflowSpanProcessor +
    // http_governance_hooks). Patches Node.js https.request so the actual HTTP
    // call to the LLM provider is intercepted and its request/response bodies
    // are sent to Core as ActivityStarted + hook_trigger + http_request spans.
    const activityCtxBase = (0, hooks_1.baseEventFields)(mw, turn);
    (0, span_processor_1.registerActivity)(activityId, {
        ...activityCtxBase,
        event_type: 'ActivityStarted',
        activity_id: activityId,
        activity_type: 'llm_call',
    }, mw._client.executeFunctions, turn.workflowId, { hitl: mw._config.hitl, onApiError: mw._config.onApiError, logger: mw._config.logger, requestTimeoutMs: mw._config.governanceTimeout * 1000 });
    // Call the model — https.request patch fires automatically
    let modelResponse;
    let llmWasApproved = false;
    try {
        while (true) {
            try {
                modelResponse = await (0, span_processor_1.runWithActivity)(activityId, handler);
                // Some LLM clients swallow the completed-span abort internally (mirrors
                // the Wikipedia-tool case in handleWrapToolCall) — the hook still set the
                // abort flag before letting the response through, so check it here too.
                if ((0, span_processor_1.hasActivityAbort)(activityId)) {
                    await (0, hitl_1.pollApprovalOrHalt)(mw, turn, activityId, 'llm_call');
                    (0, span_processor_1.markActivityApproved)(activityId);
                    (0, span_processor_1.clearActivityAbort)(activityId);
                    continue;
                }
                break;
            }
            catch (err) {
                const hookErr = (0, hooks_1.extractGovernanceBlocked)(err);
                if (hookErr?.verdict === 'require_approval') {
                    await (0, hitl_1.pollApprovalOrHalt)(mw, turn, activityId, 'llm_call');
                    (0, span_processor_1.markActivityApproved)(activityId);
                    (0, span_processor_1.clearActivityAbort)(activityId);
                    continue;
                }
                // A GovernanceHaltError/GovernanceBlockedError thrown inside the
                // patched fetch (e.g. a mid-call HTTP hook rejection) surfaces here
                // wrapped in whatever generic transport error the LLM client uses —
                // e.g. the OpenAI SDK wraps ANY fetch-throw as APIConnectionError
                // with the fixed message "Connection error.", burying our real
                // reason ("Activity rejected: ...") in `.cause`. Prefer the reason we
                // recorded ourselves at the moment of the abort (span_processor.ts's
                // abortAndThrow) — it's reliable regardless of how the client library
                // mangled the exception. Fall back to unwrapping the caught error's
                // cause chain, then to the raw error, only if nothing was recorded.
                const abortReasonText = (0, span_processor_1.getActivityAbortReason)(activityId);
                const failure = abortReasonText != null
                    ? new verdict_1.GovernanceHaltError(abortReasonText)
                    : (0, verdict_1.unwrapGovernanceError)(err) ?? err;
                // A genuine (non-governance) model-call failure — close the llm_call
                // row instead of leaving it orphaned.
                if (mw._config.sendLlmEndEvent) {
                    await (0, hooks_1.sendOrphanClosure)(mw, turn, 'LLMCompleted', activityId, 'llm_call', failure);
                }
                throw failure;
            }
        }
        // Capture BEFORE finally runs — unregisterActivity clears _approvedActivities.
        llmWasApproved = (0, span_processor_1.isActivityApproved)(activityId);
    }
    finally {
        (0, span_processor_1.unregisterActivity)(activityId);
    }
    const endMs = Date.now();
    const duration_ms = endMs - startMs;
    // LLMCompleted — skip evaluate entirely when already approved to avoid
    // spurious approval requests on Core for the same activity_type. Reuses
    // the SAME activityId as LLMStarted — Core matches completions to starts
    // by activity_id; a different id produces an orphan Core discards.
    if (mw._config.sendLlmEndEvent && !llmWasApproved) {
        const meta = (0, hooks_1.extractResponseMetadata)(modelResponse);
        const resp = await (0, hooks_1.evaluate)(mw, (0, hooks_1.buildEvent)(mw, turn, 'LLMCompleted', activityId, 'llm_call', {
            status: 'completed',
            duration_ms,
            llm_model: meta.llm_model,
            input_tokens: meta.input_tokens,
            output_tokens: meta.output_tokens,
            total_tokens: meta.total_tokens,
            has_tool_calls: meta.has_tool_calls,
            completion: meta.completion,
        }));
        if (resp != null) {
            const endResult = (0, verdict_1.enforceVerdict)(resp, 'llm_end');
            if (endResult.requiresHitl) {
                await (0, hitl_1.pollApprovalOrHalt)(mw, turn, activityId, 'llm_call', endResult.approvalId);
            }
        }
    }
    return modelResponse;
}
// ═══════════════════════════════════════════════════════════════════
// handle_wrap_memory_op → scopes memory load/save so pg queries
// inside the memory node generate db_query spans on the dashboard.
// ═══════════════════════════════════════════════════════════════════
async function handleWrapMemoryOp(mw, turn, opType, fn) {
    const activityId = (0, types_1.hexId)(32);
    const startMs = Date.now();
    // Send explicit ActivityStarted evaluate BEFORE registering the activity.
    // This creates an anchor node in Core's timeline so subsequent DB hook_triggers
    // (hook_trigger:true, stage:'started'|'completed') are grouped under it
    // instead of each creating their own ActivityStarted node. Mirrors how
    // LLMStarted anchors HTTP spans for llm_call activities.
    try {
        await (0, hooks_1.evaluate)(mw, (0, hooks_1.buildEvent)(mw, turn, 'ActivityStarted', activityId, opType));
    }
    catch { /* non-fatal */ }
    (0, span_processor_1.registerActivity)(activityId, {
        ...(0, hooks_1.baseEventFields)(mw, turn),
        event_type: 'ActivityStarted',
        activity_id: activityId,
        activity_type: opType,
    }, mw._client.executeFunctions, turn.workflowId, { hitl: mw._config.hitl, onApiError: mw._config.onApiError, logger: mw._config.logger, requestTimeoutMs: mw._config.governanceTimeout * 1000 });
    // Capture result so ActivityCompleted can include activity_output.
    // The Python SDK (activity_interceptor._send_activity_event) uses the same
    // activity_id for both ActivityStarted and ActivityCompleted. Core matches
    // completions to their starts by activity_id; a different id (e.g. '-c' suffix)
    // produces an orphan that Core discards — the dashboard shows "started, never ended".
    // When fn() throws (e.g. Postgres error), the Python SDK never calls
    // _handle_completion (Temporal runtime tracks the failure). In n8n we have no
    // runtime, so we always send ActivityCompleted from finally — with the correct id.
    let status = 'completed';
    let errorInfo;
    let result;
    try {
        // DB spans evaluated during fn() (a memory load/save) can come back
        // require_approval — the DB hook swallows that internally so the query
        // completes normally, but flags the abort. Poll and retry here, mirroring
        // handleWrapToolCall's hasActivityAbort check, instead of letting the
        // approval requirement pass through unenforced.
        while (true) {
            try {
                result = await (0, span_processor_1.runWithActivity)(activityId, fn);
                if ((0, span_processor_1.hasActivityAbort)(activityId)) {
                    await (0, hitl_1.pollApprovalOrHalt)(mw, turn, activityId, opType);
                    (0, span_processor_1.clearActivityAbort)(activityId);
                    continue;
                }
                break;
            }
            catch (err) {
                const hookErr = (0, hooks_1.extractGovernanceBlocked)(err);
                if (hookErr?.verdict === 'require_approval') {
                    await (0, hitl_1.pollApprovalOrHalt)(mw, turn, activityId, opType);
                    (0, span_processor_1.clearActivityAbort)(activityId);
                    continue;
                }
                throw err;
            }
        }
        return result;
    }
    catch (err) {
        // Same rationale as handleWrapModelCall: a DB driver may wrap a thrown
        // GovernanceHaltError/GovernanceBlockedError in its own error type. Prefer
        // the reason recorded at the moment of the abort over the (possibly
        // mangled) caught error.
        const abortReasonText = (0, span_processor_1.getActivityAbortReason)(activityId);
        const failure = abortReasonText != null
            ? new verdict_1.GovernanceHaltError(abortReasonText)
            : (0, verdict_1.unwrapGovernanceError)(err) ?? err;
        status = 'failed';
        errorInfo = (0, error_info_1.toErrorInfo)(failure);
        throw failure;
    }
    finally {
        (0, span_processor_1.unregisterActivity)(activityId);
        const completedEvent = (0, hooks_1.buildEvent)(mw, turn, 'ActivityCompleted', activityId, opType, {
            status,
            duration_ms: Date.now() - startMs,
            activity_output: status === 'completed' ? (0, types_1.safeSerialize)(result) : null,
            spans: [],
            span_count: 0,
            ...(errorInfo ? { error: errorInfo } : {}),
        });
        // Await ActivityCompleted so it arrives at Core before the caller proceeds
        // to the next lifecycle event (e.g. LLMStarted). Matches Python SDK's
        // sequential await pattern — all events must be strictly ordered by arrival.
        try {
            await (0, hooks_1.evaluate)(mw, completedEvent);
        }
        catch { /* non-fatal */ }
    }
}
