"use strict";
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
const hitl_1 = require("./hitl");
const span_processor_1 = require("./span_processor");
const openbox_client_1 = require("../openbox-client");
const types_1 = require("./types");
const verdict_1 = require("./verdict");
// ═══════════════════════════════════════════════════════════════════
// handle_before_agent → SignalReceived + WorkflowStarted + pre-screen
// ═══════════════════════════════════════════════════════════════════
async function handleBeforeAgent(mw, state, threadId = 'n8n') {
    const turn = (0, types_1.hexId)(32);
    mw._workflowId = `${threadId}-${turn.slice(0, 8)}`;
    mw._runId = `${threadId}-run-${turn.slice(8, 16)}`;
    mw._client.updateTraceId(mw._workflowId);
    // The constructor adds OPENBOX_API_URL to _ignoredPrefixes, but the actual
    // URL for requests comes from the n8n credential (openboxUrl), which may
    // differ. Ensure it is ignored so HTTP calls to Core made while a tool
    // activity is registered don't get intercepted as hook spans and sent back
    // to Core a second time, creating duplicate approval requests.
    try {
        const creds = await (0, openbox_client_1.getOpenBoxCredentials)(mw._client.executeFunctions);
        (0, span_processor_1.addIgnoredPrefix)(creds.openboxUrl);
    }
    catch { /* non-fatal — constructor already added the env-var URL */ }
    const messages = state.messages ?? [];
    const userPrompt = (0, hooks_1.extractLastUserMessage)(messages);
    // SignalReceived — user prompt as trigger
    // Each event gets a fresh baseEventFields() call so timestamps are strictly
    // increasing and the server sorts them in the correct order.
    if (userPrompt) {
        await (0, hooks_1.evaluate)(mw, {
            ...(0, hooks_1.baseEventFields)(mw),
            event_type: 'SignalReceived',
            activity_id: `${mw._runId}-sig`,
            activity_type: 'user_prompt',
            signal_name: 'user_prompt',
            signal_args: [userPrompt],
        });
    }
    // WorkflowStarted
    if (mw._config.sendChainStartEvent) {
        await (0, hooks_1.evaluate)(mw, {
            ...(0, hooks_1.baseEventFields)(mw),
            event_type: 'WorkflowStarted',
            activity_id: `${mw._runId}-wf`,
            activity_type: mw._workflowType,
            activity_input: [(0, types_1.safeSerialize)(state)],
        });
    }
    // LLMStarted pre-screen is intentionally deferred to handleWrapModelCall.
    // Sending LLMStarted here (before memory_load) would anchor the llm_call
    // activity to the before_agent timestamp, causing Core to display it before
    // the memory_load activity even though the model call happens after.
    // wrapModelCall sends LLMStarted at the correct time (after memory is loaded),
    // so all events arrive at Core in true execution order.
}
// ═══════════════════════════════════════════════════════════════════
// handle_after_agent → WorkflowCompleted
// ═══════════════════════════════════════════════════════════════════
async function handleAfterAgent(mw, state, failedWith) {
    if (!mw._config.sendChainEndEvent)
        return null;
    const messages = state.messages ?? [];
    let lastContent = null;
    if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        lastContent = lastMsg?.content ?? null;
    }
    const verdict = await (0, hooks_1.evaluate)(mw, {
        ...(0, hooks_1.baseEventFields)(mw),
        event_type: 'WorkflowCompleted',
        activity_id: `${mw._runId}-wf`,
        activity_type: mw._workflowType,
        workflow_output: (0, types_1.safeSerialize)({ result: lastContent }),
        status: failedWith ? 'failed' : 'completed',
        ...(failedWith ? { error: failedWith.message } : {}),
    });
    // Clean up any lingering activity registrations for this workflow.
    // Mirrors Python SDK's span_processor.unregister_workflow(workflow_id).
    (0, span_processor_1.unregisterWorkflow)(mw._workflowId);
    return verdict;
}
// ═══════════════════════════════════════════════════════════════════
// handle_wrap_model_call → LLMStarted → PII redact → Model → LLMCompleted
// ═══════════════════════════════════════════════════════════════════
async function handleWrapModelCall(mw, messages, handler) {
    // Use only the last human message as the governed prompt — extractPromptFromMessages
    // would join ALL human messages including chat history loaded from memory, producing
    // a concatenated blob of prior turns instead of the current user input.
    const promptText = (0, hooks_1.extractLastUserMessage)(messages) ?? (0, hooks_1.extractPromptFromMessages)(messages);
    if (!promptText.trim())
        return handler();
    const b = (0, hooks_1.baseEventFields)(mw);
    const activityId = (0, types_1.hexId)(32);
    let startResponse;
    const startMs = Date.now();
    if (mw._config.sendLlmStartEvent) {
        startResponse = await (0, hooks_1.evaluate)(mw, {
            ...b,
            event_type: 'LLMStarted',
            activity_id: activityId,
            activity_type: 'llm_call',
            activity_input: [{ prompt: promptText }],
            prompt: promptText,
        });
    }
    else {
        startResponse = null;
    }
    // PII redaction — only apply when the returned text is ≤ the prompt we sent.
    // Redaction removes/replaces content; it never expands it. If Core returns a
    // longer string it is echoing stale data from a prior session — applying it
    // would overwrite the current user message with a concatenation of past turns.
    const guardrails = startResponse?.guardrails_result ?? startResponse?.guardrailsResult;
    if (guardrails) {
        const gr = guardrails;
        if (gr.input_type === 'activity_input' && gr.redacted_input != null) {
            const ri = gr.redacted_input;
            const redactedStr = typeof ri === 'string' ? ri
                : Array.isArray(ri) && ri.length > 0
                    ? (typeof ri[0] === 'string'
                        ? ri[0]
                        : (typeof ri[0] === 'object' && ri[0] !== null
                            ? (ri[0].prompt ?? null)
                            : null))
                    : null;
            // Allow 64 chars slack for replacements like "[SSN]" → "[REDACTED-SSN]"
            if (redactedStr == null || redactedStr.length <= promptText.length + 64) {
                (0, hooks_1.applyPiiRedaction)(messages, gr.redacted_input);
            }
        }
    }
    // Enforce LLMStarted verdict (block/halt throw; require_approval polls)
    if (startResponse != null) {
        const result = (0, verdict_1.enforceVerdict)(startResponse, 'llm_start');
        if (result.requiresHitl) {
            await (0, hitl_1.pollApprovalOrHalt)(mw, activityId, 'llm_call', result.approvalId);
            (0, span_processor_1.markActivityApproved)(activityId);
        }
    }
    // ── Layer 2: HTTP span collector (mirrors Python's WorkflowSpanProcessor +
    // http_governance_hooks). Patches Node.js https.request so the actual HTTP
    // call to the LLM provider is intercepted and its request/response bodies
    // are sent to Core as ActivityStarted + hook_trigger + http_request spans.
    const activityCtxBase = (0, hooks_1.baseEventFields)(mw);
    (0, span_processor_1.registerActivity)(activityId, {
        ...activityCtxBase,
        event_type: 'ActivityStarted',
        activity_id: activityId,
        activity_type: 'llm_call',
    }, mw._client.executeFunctions, mw._workflowId);
    // Call the model — https.request patch fires automatically
    let modelResponse;
    let llmWasApproved = false;
    try {
        while (true) {
            try {
                modelResponse = await (0, span_processor_1.runWithActivity)(activityId, handler);
                break;
            }
            catch (err) {
                const hookErr = (0, hooks_1.extractGovernanceBlocked)(err);
                if (hookErr?.verdict === 'require_approval') {
                    await (0, hitl_1.pollApprovalOrHalt)(mw, activityId, 'llm_call');
                    (0, span_processor_1.markActivityApproved)(activityId);
                    (0, span_processor_1.clearActivityAbort)(activityId);
                    continue;
                }
                throw err;
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
    // spurious approval requests on Core for the same activity_type.
    if (mw._config.sendLlmEndEvent && !llmWasApproved) {
        const meta = (0, hooks_1.extractResponseMetadata)(modelResponse);
        const resp = await (0, hooks_1.evaluate)(mw, {
            ...(0, hooks_1.baseEventFields)(mw),
            event_type: 'LLMCompleted',
            activity_id: `${activityId}-c`,
            activity_type: 'llm_call',
            status: 'completed',
            duration_ms,
            llm_model: meta.llm_model,
            input_tokens: meta.input_tokens,
            output_tokens: meta.output_tokens,
            total_tokens: meta.total_tokens,
            has_tool_calls: meta.has_tool_calls,
            completion: meta.completion,
        });
        if (resp != null) {
            const endResult = (0, verdict_1.enforceVerdict)(resp, 'llm_end');
            if (endResult.requiresHitl) {
                await (0, hitl_1.pollApprovalOrHalt)(mw, `${activityId}-c`, 'llm_call', endResult.approvalId);
            }
        }
    }
    return modelResponse;
}
// ═══════════════════════════════════════════════════════════════════
// handle_wrap_memory_op → scopes memory load/save so pg queries
// inside the memory node generate db_query spans on the dashboard.
// ═══════════════════════════════════════════════════════════════════
async function handleWrapMemoryOp(mw, opType, fn) {
    const activityId = (0, types_1.hexId)(32);
    const startMs = Date.now();
    const b = (0, hooks_1.baseEventFields)(mw);
    // Send explicit ActivityStarted evaluate BEFORE registering the activity.
    // This creates an anchor node in Core's timeline so subsequent DB hook_triggers
    // (hook_trigger:true, stage:'started'|'completed') are grouped under it
    // instead of each creating their own ActivityStarted node. Mirrors how
    // LLMStarted anchors HTTP spans for llm_call activities.
    try {
        await (0, hooks_1.evaluate)(mw, {
            ...b,
            event_type: 'ActivityStarted',
            activity_id: activityId,
            activity_type: opType,
        });
    }
    catch { /* non-fatal */ }
    (0, span_processor_1.registerActivity)(activityId, {
        ...b,
        event_type: 'ActivityStarted',
        activity_id: activityId,
        activity_type: opType,
    }, mw._client.executeFunctions, mw._workflowId);
    let status = 'completed';
    let errorMsg;
    try {
        return await (0, span_processor_1.runWithActivity)(activityId, fn);
    }
    catch (err) {
        status = 'failed';
        errorMsg = String(err);
        throw err;
    }
    finally {
        (0, span_processor_1.unregisterActivity)(activityId);
        const completedEvent = {
            ...(0, hooks_1.baseEventFields)(mw),
            event_type: 'ActivityCompleted',
            activity_id: `${activityId}-c`,
            activity_type: opType,
            status,
            duration_ms: Date.now() - startMs,
        };
        if (errorMsg)
            completedEvent.error = errorMsg;
        // Await ActivityCompleted so it arrives at Core before the caller proceeds
        // to the next lifecycle event (e.g. LLMStarted). Matches Python SDK's
        // sequential await pattern — all events must be strictly ordered by arrival.
        try {
            await (0, hooks_1.evaluate)(mw, completedEvent);
        }
        catch { /* non-fatal */ }
    }
}
