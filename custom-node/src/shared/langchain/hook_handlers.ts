/**
 * Hook handler functions — TypeScript port of middleware_hook_handlers.py.
 *
 * handle_before_agent / handle_after_agent / handle_wrap_model_call.
 */

import {
  applyPiiRedaction,
  baseEventFields,
  evaluate,
  extractGovernanceBlocked,
  extractLastUserMessage,
  extractPromptFromMessages,
  extractResponseMetadata,
} from './hooks';
import { pollApprovalOrHalt } from './hitl';
import {
  clearActivityAbort,
  registerActivity,
  runWithActivity,
  unregisterActivity,
} from './span_processor';
import type { OpenBoxLangChainMiddleware } from './middleware';
import {
  GovernanceVerdictResponse,
  LangChainGovernanceEvent,
  hexId,
  safeSerialize,
} from './types';
import { enforceVerdict } from './verdict';

export interface AgentState {
  messages: unknown[];
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════
// handle_before_agent → SignalReceived + WorkflowStarted + pre-screen
// ═══════════════════════════════════════════════════════════════════

export async function handleBeforeAgent(
  mw: OpenBoxLangChainMiddleware,
  state: AgentState,
  threadId: string = 'n8n',
): Promise<void> {
  const turn = hexId(32);
  mw._workflowId = `${threadId}-${turn.slice(0, 8)}`;
  mw._runId = `${threadId}-run-${turn.slice(8, 16)}`;
  mw._firstLlmCall = true;
  mw._preScreenResponse = null;
  mw._client.updateTraceId(mw._workflowId);

  const messages = state.messages ?? [];
  const userPrompt = extractLastUserMessage(messages);

  // SignalReceived — user prompt as trigger
  // Each event gets a fresh baseEventFields() call so timestamps are strictly
  // increasing and the server sorts them in the correct order.
  if (userPrompt) {
    await evaluate(mw, {
      ...baseEventFields(mw),
      event_type: 'SignalReceived',
      activity_id: `${mw._runId}-sig`,
      activity_type: 'user_prompt',
      signal_name: 'user_prompt',
      signal_args: [userPrompt],
    } as LangChainGovernanceEvent);
  }

  // WorkflowStarted
  if (mw._config.sendChainStartEvent) {
    await evaluate(mw, {
      ...baseEventFields(mw),
      event_type: 'WorkflowStarted',
      activity_id: `${mw._runId}-wf`,
      activity_type: mw._workflowType,
      activity_input: [safeSerialize(state)],
    } as LangChainGovernanceEvent);
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

export async function handleAfterAgent(
  mw: OpenBoxLangChainMiddleware,
  state: AgentState,
): Promise<GovernanceVerdictResponse | null> {
  if (!mw._config.sendChainEndEvent) return null;

  const messages = state.messages ?? [];
  let lastContent: unknown = null;
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1] as Record<string, unknown>;
    lastContent = lastMsg?.content ?? null;
  }

  return evaluate(mw, {
    ...baseEventFields(mw),
    event_type: 'WorkflowCompleted',
    activity_id: `${mw._runId}-wf`,
    activity_type: mw._workflowType,
    workflow_output: safeSerialize({ result: lastContent }),
    status: 'completed',
  } as LangChainGovernanceEvent);
}

// ═══════════════════════════════════════════════════════════════════
// handle_wrap_model_call → LLMStarted → PII redact → Model → LLMCompleted
// ═══════════════════════════════════════════════════════════════════

export async function handleWrapModelCall(
  mw: OpenBoxLangChainMiddleware,
  messages: unknown[],
  handler: () => Promise<unknown>,
): Promise<unknown> {
  const promptText = extractPromptFromMessages(messages);
  if (!promptText.trim()) return handler();

  const b = baseEventFields(mw);
  const activityId = hexId(32);
  let startResponse: GovernanceVerdictResponse | null;
  const startMs = Date.now();
  mw._firstLlmCall = false;

  if (mw._config.sendLlmStartEvent) {
    startResponse = await evaluate(mw, {
      ...b,
      event_type: 'LLMStarted',
      activity_id: activityId,
      activity_type: 'llm_call',
      activity_input: [{ prompt: promptText }],
      prompt: promptText,
    } as LangChainGovernanceEvent);
  } else {
    startResponse = null;
  }

  // PII redaction — mutate messages before handing to the model
  const guardrails = startResponse?.guardrails_result ?? startResponse?.guardrailsResult;
  if (guardrails) {
    const gr = guardrails;
    if (gr.input_type === 'activity_input' && gr.redacted_input != null) {
      applyPiiRedaction(messages, gr.redacted_input);
    }
  }

  // Enforce LLMStarted verdict (block/halt throw; require_approval polls)
  if (startResponse != null) {
    const result = enforceVerdict(startResponse, 'llm_start');
    if (result.requiresHitl) {
      await pollApprovalOrHalt(mw, activityId, 'llm_call');
    }
  }

  // ── Layer 2: HTTP span collector (mirrors Python's WorkflowSpanProcessor +
  // http_governance_hooks). Patches Node.js https.request so the actual HTTP
  // call to the LLM provider is intercepted and its request/response bodies
  // are sent to Core as ActivityStarted + hook_trigger + http_request spans.
  const activityCtxBase = baseEventFields(mw);
  registerActivity(
    activityId,
    {
      ...activityCtxBase,
      event_type: 'ActivityStarted',
      activity_id: activityId,
      activity_type: 'llm_call',
    },
    mw._client.executeFunctions,
    mw._workflowId,
  );

  // Call the model — https.request patch fires automatically
  let modelResponse: unknown;
  try {
    while (true) {
      try {
        modelResponse = await runWithActivity(activityId, handler);
        break;
      } catch (err) {
        const hookErr = extractGovernanceBlocked(err);
        if (hookErr?.verdict === 'require_approval') {
          await pollApprovalOrHalt(mw, activityId, 'llm_call');
          clearActivityAbort(activityId);
          continue;
        }
        throw err;
      }
    }
  } finally {
    unregisterActivity(activityId);
  }
  const endMs = Date.now();
  const duration_ms = endMs - startMs;

  // LLMCompleted
  if (mw._config.sendLlmEndEvent) {
    const meta = extractResponseMetadata(modelResponse);
    const resp = await evaluate(mw, {
      ...baseEventFields(mw),
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
    } as LangChainGovernanceEvent);

    if (resp != null) {
      enforceVerdict(resp, 'llm_end');
    }
  }

  return modelResponse;
}

// ═══════════════════════════════════════════════════════════════════
// handle_wrap_memory_op → scopes memory load/save so pg queries
// inside the memory node generate db_query spans on the dashboard.
// ═══════════════════════════════════════════════════════════════════

export async function handleWrapMemoryOp<T>(
  mw: OpenBoxLangChainMiddleware,
  opType: 'memory_load' | 'memory_save',
  fn: () => Promise<T>,
): Promise<T> {
  const activityId = hexId(32);
  const startMs = Date.now();
  const b = baseEventFields(mw);

  // Register the activity so db/file hooks inside the memory op can emit
  // hook_trigger span payloads. The first hook_trigger (db_query started) acts
  // as the ActivityStarted node on the Core dashboard — exactly how http hooks
  // work for llm_call. We intentionally do NOT send an explicit evaluate()
  // ActivityStarted here: doing so created a duplicate "started" node because
  // Core also renders each hook_trigger payload (which carries event_type:
  // 'ActivityStarted' from the registered context) as a timeline node.
  registerActivity(
    activityId,
    {
      ...b,
      event_type: 'ActivityStarted',
      activity_id: activityId,
      activity_type: opType,
    },
    mw._client.executeFunctions,
    mw._workflowId,
  );

  let status: 'completed' | 'failed' = 'completed';
  let errorMsg: string | undefined;
  try {
    return await runWithActivity(activityId, fn);
  } catch (err) {
    status = 'failed';
    errorMsg = String(err);
    throw err;
  } finally {
    unregisterActivity(activityId);
    const completedEvent: LangChainGovernanceEvent = {
      ...baseEventFields(mw),
      event_type: 'ActivityCompleted',
      activity_id: `${activityId}-c`,
      activity_type: opType,
      status,
      duration_ms: Date.now() - startMs,
    };
    if (errorMsg) completedEvent.error = errorMsg;
    // Await ActivityCompleted so it arrives at Core before the caller proceeds
    // to the next lifecycle event (e.g. LLMStarted). Matches Python SDK's
    // sequential await pattern — all events must be strictly ordered by arrival.
    try {
      await evaluate(mw, completedEvent);
    } catch { /* non-fatal */ }
  }
}
