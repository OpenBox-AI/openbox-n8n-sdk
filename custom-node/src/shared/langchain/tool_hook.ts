/* eslint-disable @n8n/community-nodes/require-node-api-error */
/**
 * Tool governance hook — TypeScript port of middleware_tool_hook.py.
 *
 * handle_wrap_tool_call: ToolStarted → execute tool → ToolCompleted.
 */

import { baseEventFields, evaluate, extractGovernanceBlocked } from './hooks';
import {
  clearActivityAbort,
  hasActivityAbort,
  isActivityApproved,
  markActivityApproved,
  registerActivity,
  runWithActivity,
  unregisterActivity,
} from './span_processor';
import { pollApprovalOrHalt } from './hitl';
import type { OpenBoxLangChainMiddleware } from './middleware';
import { LangChainGovernanceEvent, hexId, safeSerialize } from './types';
import { GovernanceBlockedError, enforceVerdict } from './verdict';

export async function handleWrapToolCall(
  mw: OpenBoxLangChainMiddleware,
  toolName: string,
  toolArgs: unknown,
  handler: () => Promise<unknown>,
): Promise<unknown> {
  // Skip governance for excluded tools (mirrors skip_tool_types config)
  if (mw._config.skipToolTypes.has(toolName)) {
    return handler();
  }

  const activityId = hexId(32);
  const toolType = mw._config.toolTypeMap[toolName];
  const startMs = Date.now();
  const b = baseEventFields(mw);

  // ── ToolStarted ──────────────────────────────────────────────────────────────
  // registerActivity is called AFTER this evaluate (mirrors handleWrapModelCall).
  // Registering before the evaluate would put the activity in _activeActivities
  // while the HTTP request for the evaluate call fires — patchedFetch would then
  // capture that request as a hook span for the tool activity, sending a second
  // governance event to Core and creating a duplicate approval request.
  if (mw._config.sendToolStartEvent) {
    const response = await evaluate(mw, {
      ...b,
      event_type: 'ToolStarted',
      activity_id: activityId,
      activity_type: toolName,
      activity_input: [safeSerialize(toolArgs)],
      tool_name: toolName,
      tool_type: toolType,
    } as LangChainGovernanceEvent);

    if (response != null) {
      const result = enforceVerdict(response, 'tool_start');
      if (result.requiresHitl) {
        await pollApprovalOrHalt(mw, activityId, toolName, result.approvalId);
        markActivityApproved(activityId);
        clearActivityAbort(activityId);
      }
    }
  }

  registerActivity(
    activityId,
    {
      ...b,
      event_type: 'ActivityStarted',
      activity_id: activityId,
      activity_type: toolName,
    },
    mw._client.executeFunctions,
    mw._workflowId,
  );

  // ── Execute tool ─────────────────────────────────────────────────────────────
  let toolResult: unknown;
  // Capture approval state before unregisterActivity clears it in the finally block.
  let wasApproved = false;
  try {
    while (true) {
      try {
        toolResult = await runWithActivity(activityId, handler);
        // Some LangChain tools (e.g. Wikipedia) catch HTTP errors internally and
        // return them as strings rather than throwing. The hook still set the abort
        // flag before throwing — check it here so approval is triggered even when
        // the GovernanceBlockedError never propagated to this catch block.
        if (hasActivityAbort(activityId)) {
          await pollApprovalOrHalt(mw, activityId, toolName);
          markActivityApproved(activityId);
          clearActivityAbort(activityId);
          continue;
        }
        break;
      } catch (err) {
        const hookErr =
          err instanceof GovernanceBlockedError ? err : extractGovernanceBlocked(err);
        if (hookErr?.verdict === 'require_approval') {
          await pollApprovalOrHalt(mw, activityId, toolName);
          markActivityApproved(activityId);
          clearActivityAbort(activityId);
          continue;
        }

        const failEndMs = Date.now();
        if (mw._config.sendToolEndEvent && !isActivityApproved(activityId)) {
          await evaluate(mw, {
            ...baseEventFields(mw),
            event_type: 'ToolCompleted',
            activity_id: `${activityId}-c`,
            activity_type: toolName,
            activity_output: safeSerialize({ error: String(err) }),
            tool_name: toolName,
            tool_type: toolType,
            status: 'failed',
            duration_ms: failEndMs - startMs,
            error: String(err),
          } as LangChainGovernanceEvent);
        }
        throw err;
      }
    }
    // Capture BEFORE finally runs — unregisterActivity clears _approvedActivities.
    wasApproved = isActivityApproved(activityId);
  } finally {
    unregisterActivity(activityId);
  }

  const endMs = Date.now();
  const duration_ms = endMs - startMs;

  // ── ToolCompleted ─────────────────────────────────────────────────────────────
  if (mw._config.sendToolEndEvent) {
    // String results wrapped as {result: ...}, non-strings serialized directly
    const serializedOutput =
      typeof toolResult === 'string'
        ? safeSerialize({ result: toolResult })
        : safeSerialize(toolResult);

    // Always send ToolCompleted so Core can show the completion on the dashboard.
    // When wasApproved=true (ToolStarted already required+received human approval),
    // send the event but skip verdict enforcement — enforcing it would trigger a
    // second governance evaluation and create a spurious approval row on Core.
    // Use wasApproved (captured before finally) because unregisterActivity already
    // cleared _approvedActivities by the time we reach here.
    const resp = await evaluate(mw, {
      ...baseEventFields(mw),
      event_type: 'ToolCompleted',
      activity_id: `${activityId}-c`,
      activity_type: toolName,
      activity_output: serializedOutput,
      tool_name: toolName,
      tool_type: toolType,
      status: 'completed',
      duration_ms,
    } as LangChainGovernanceEvent);

    if (resp != null && !wasApproved) {
      const result = enforceVerdict(resp, 'tool_end');
      if (result.requiresHitl) {
        await pollApprovalOrHalt(mw, `${activityId}-c`, toolName, result.approvalId);
      }
    }
  }

  return toolResult;
}
