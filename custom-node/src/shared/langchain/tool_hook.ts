/**
 * Tool governance hook — TypeScript port of middleware_tool_hook.py.
 *
 * handle_wrap_tool_call: ToolStarted → execute tool → ToolCompleted.
 */

import { baseEventFields, evaluate, extractGovernanceBlocked } from './hooks';
import {
  clearActivityAbort,
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

  // ── ToolStarted ──────────────────────────────────────────────────────────────
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
        await pollApprovalOrHalt(mw, activityId, toolName);
        clearActivityAbort(activityId);
      }
    }
  }

  // ── Execute tool ─────────────────────────────────────────────────────────────
  let toolResult: unknown;
  try {
    while (true) {
      try {
        toolResult = await runWithActivity(activityId, handler);
        break;
      } catch (err) {
        const hookErr =
          err instanceof GovernanceBlockedError ? err : extractGovernanceBlocked(err);
        if (hookErr?.verdict === 'require_approval') {
          await pollApprovalOrHalt(mw, activityId, toolName);
          clearActivityAbort(activityId);
          continue;
        }

        const failEndMs = Date.now();
        if (mw._config.sendToolEndEvent) {
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

    if (resp != null) {
      const result = enforceVerdict(resp, 'tool_end');
      if (result.requiresHitl) {
        await pollApprovalOrHalt(mw, `${activityId}-c`, toolName);
      }
    }
  }

  return toolResult;
}
