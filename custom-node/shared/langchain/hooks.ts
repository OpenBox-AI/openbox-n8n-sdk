/**
 * Hook helper functions — TypeScript port of middleware_hooks.py.
 *
 * _base_event_fields, _evaluate, _extract_last_user_message,
 * _extract_prompt_from_messages, _apply_pii_redaction,
 * _extract_response_metadata.
 */

import type { OpenBoxLangChainMiddleware } from './middleware';
import { GovernanceVerdictResponse, LangChainGovernanceEvent, rfc3339Now } from './types';
import { GovernanceBlockedError } from './verdict';
import { toErrorInfo } from './error-info';

// ── _base_event_fields ────────────────────────────────────────────────────────

export interface Turn {
  workflowId: string;
  runId: string;
}

/**
 * Recover the turn identity from an error thrown by beforeAgent(). Governance
 * failures (block/halt, or a hard API error) can throw before beforeAgent
 * returns its Turn — the caller still needs workflow_id/run_id to call
 * afterAgent() and close the workflow, so beforeAgent attaches it to the
 * error before rethrowing.
 */
export function turnFromError(err: unknown): Turn | undefined {
  if (err == null || typeof err !== 'object') return undefined;
  const turn = (err as Record<string, unknown>).__obTurn;
  return turn as Turn | undefined;
}

export function baseEventFields(mw: OpenBoxLangChainMiddleware, turn: Turn): {
  source: 'workflow-telemetry';
  workflow_id: string;
  run_id: string;
  workflow_type: string;
  task_queue: string;
  timestamp: string;
  session_id: string | undefined;
  agent_name: string | undefined;
} {
  return {
    source: 'workflow-telemetry',
    workflow_id: turn.workflowId,
    run_id: turn.runId,
    workflow_type: mw._workflowType,
    task_queue: mw._config.taskQueue,
    timestamp: rfc3339Now(),
    session_id: mw._config.sessionId,
    agent_name: mw._config.agentName ?? mw._workflowType,
  };
}

/**
 * Build a governance event. One shared seam instead of ad hoc object literals
 * at every call site — `fields` carries whatever is specific to this event
 * type/call (activity_input, prompt, tool_name, error, ...), applied last so
 * a caller can always override a base field if it genuinely needs to.
 */
export function buildEvent(
  mw: OpenBoxLangChainMiddleware,
  turn: Turn,
  eventType: string,
  activityId: string,
  activityType: string,
  // Partial<LangChainGovernanceEvent> (not Record<string, unknown>) so that,
  // e.g., `error: someBareString` fails to compile here the same way it
  // would in a direct object literal — a plain Record<string, unknown> would
  // let a bare string slip past the ErrorInfo typing via this parameter.
  fields: Partial<LangChainGovernanceEvent> = {},
): LangChainGovernanceEvent {
  return {
    ...baseEventFields(mw, turn),
    event_type: eventType,
    activity_id: activityId,
    activity_type: activityType,
    ...fields,
  } as LangChainGovernanceEvent;
}

// ── _evaluate ─────────────────────────────────────────────────────────────────

export async function evaluate(
  mw: OpenBoxLangChainMiddleware,
  event: LangChainGovernanceEvent,
): Promise<GovernanceVerdictResponse | null> {
  return mw._client.evaluateEvent(event, mw._config.onApiError);
}

/**
 * Close an orphaned activity row (a start event with no matching completion)
 * with a failed ActivityCompleted, using the SAME activity id, before the
 * caller rethrows a gate-enforcement error. Best-effort — a failure here must
 * never mask the original governance error.
 */
export async function sendOrphanClosure(
  mw: OpenBoxLangChainMiddleware,
  turn: Turn,
  completedEventType: 'ActivityCompleted' | 'LLMCompleted' | 'ToolCompleted',
  activityId: string,
  activityType: string,
  err: unknown,
): Promise<void> {
  try {
    await evaluate(mw, buildEvent(mw, turn, completedEventType, activityId, activityType, {
      status: 'failed',
      error: toErrorInfo(err),
    }));
  } catch {
    // non-fatal — closure telemetry must not mask the original error
  }
}

// ── _extract_governance_blocked ──────────────────────────────────────────────

export function extractGovernanceBlocked(err: unknown): GovernanceBlockedError | null {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof GovernanceBlockedError) return current;
    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      current = record.cause ?? record.context;
    } else {
      current = null;
    }
  }
  return null;
}

// ── message role / shape helpers ──────────────────────────────────────────────

/**
 * Resolve a message's role. Tries a real LangChain message instance's
 * `.getType()` method first (HumanMessage/AIMessage/ToolMessage etc. — the
 * shape produced by model.invoke()/ToolMessage construction in the n8n node),
 * then falls back to a plain `.type`/`.role` property for tuple/dict messages.
 */
function messageRole(msg: unknown): unknown {
  if (Array.isArray(msg) && msg.length === 2) return msg[0];
  if (msg !== null && typeof msg === 'object') {
    const m = msg as Record<string, unknown>;
    if (typeof m.getType === 'function') {
      try {
        return (m.getType as () => unknown).call(m);
      } catch {
        // fall through to property access
      }
    }
    return m.type ?? m.role;
  }
  return null;
}

function messageContent(msg: unknown): unknown {
  if (Array.isArray(msg) && msg.length === 2) return msg[1];
  if (msg !== null && typeof msg === 'object') return (msg as Record<string, unknown>).content;
  return null;
}

/**
 * True whenever there is a human/user/generic turn at all, independent of
 * whether the extracted text is empty or the content is multimodal. Used to
 * make sure an empty/non-text turn is still governed rather than silently
 * skipped. Role set matches extractLastUserMessage/appendHumanContent/
 * applyPiiRedaction — keep these consistent.
 */
export function hasHumanTurn(messages: unknown[]): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((msg) => {
    const role = messageRole(msg);
    return role === 'human' || role === 'user' || role === 'generic';
  });
}

// ── _extract_last_user_message ────────────────────────────────────────────────

/**
 * Find the last human/user message in an agent state messages array.
 * Handles both tuple format ['human', text] and LangChain message objects.
 */
export function extractLastUserMessage(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const role = messageRole(msg);
    if (role === 'human' || role === 'user' || role === 'generic') {
      const content = messageContent(msg);
      return typeof content === 'string' ? content : null;
    }
  }
  return null;
}

// ── _extract_prompt_from_messages ─────────────────────────────────────────────

export function extractPromptFromMessages(messages: unknown[]): string {
  if (!Array.isArray(messages)) return '';
  const parts: string[] = [];
  for (const msg of messages) {
    appendHumanContent(msg, parts);
  }
  return parts.join('\n');
}

function appendHumanContent(msg: unknown, parts: string[]): void {
  const role = messageRole(msg);
  if (role !== 'human' && role !== 'user' && role !== 'generic') return;

  const content = messageContent(msg);
  if (typeof content === 'string') {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (
        typeof part === 'object' && part !== null &&
        (part as Record<string, unknown>).type === 'text'
      ) {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
  }
}

// ── _apply_pii_redaction ──────────────────────────────────────────────────────

/**
 * Coerce Core's redacted-input payload to plain text. Accepts a bare string,
 * or an array whose first element is a string or an object carrying
 * `.prompt` or `.text` (Core has used both shapes historically).
 */
function coerceRedactedText(redactedInput: unknown): string | null {
  if (typeof redactedInput === 'string') return redactedInput || null;
  if (Array.isArray(redactedInput) && redactedInput.length > 0) {
    const first = redactedInput[0];
    if (typeof first === 'string') return first || null;
    if (typeof first === 'object' && first !== null) {
      const rec = first as Record<string, unknown>;
      const text = rec.prompt ?? rec.text;
      return typeof text === 'string' && text ? text : null;
    }
  }
  return null;
}

/**
 * Apply the redacted text to message content. For multimodal array content,
 * only the text blocks are replaced — non-text blocks (images, etc.) are left
 * untouched rather than the whole content array being discarded.
 */
function redactContent(content: unknown, redactedText: string): unknown {
  if (typeof content === 'string') return redactedText;
  if (Array.isArray(content)) {
    let replaced = false;
    return content.map((part) => {
      if (typeof part === 'object' && part !== null && (part as Record<string, unknown>).type === 'text') {
        const block = part as Record<string, unknown>;
        if (!replaced) {
          replaced = true;
          return { ...block, text: redactedText };
        }
        return { ...block, text: '' };
      }
      return part;
    });
  }
  return redactedText;
}

/**
 * Mutate the last human message in messages with the redacted text returned
 * by Core's guardrails. Mutates in place (rather than returning a copy)
 * because `messages` is the same array reference the caller's model-invoke
 * closure already captured — mutating elements is required for the redaction
 * to actually reach the model call in this architecture.
 */
export function applyPiiRedaction(messages: unknown[], redactedInput: unknown): void {
  const redactedText = coerceRedactedText(redactedInput);
  if (!redactedText) return;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const role = messageRole(msg);
    if (role !== 'human' && role !== 'user' && role !== 'generic') continue;

    if (Array.isArray(msg) && msg.length === 2) {
      messages[i] = [msg[0], redactContent(msg[1], redactedText)];
      return;
    }
    if (msg !== null && typeof msg === 'object' && 'content' in (msg as object)) {
      (msg as Record<string, unknown>).content = redactContent(
        (msg as Record<string, unknown>).content,
        redactedText,
      );
      return;
    }
  }
}

// ── OpenAI-format serializers (for Layer 2 http_request spans) ───────────────

/**
 * Convert one LangChain message (tuple or object) to an OpenAI-format message.
 * Mirrors what httpx body capture sees on the wire in the Python SDK.
 */
function lcMsgToOpenAi(msg: unknown): Record<string, unknown> | null {
  if (Array.isArray(msg) && msg.length === 2) {
    const [role, content] = msg as [string, unknown];
    const oaiRole = role === 'human' || role === 'user' ? 'user' : role;
    return { role: oaiRole, content };
  }
  if (msg !== null && typeof msg === 'object') {
    const m = msg as Record<string, unknown>;
    const type = m.type as string | undefined;
    const oaiRole =
      type === 'human' ? 'user'
      : type === 'ai' ? 'assistant'
      : type === 'tool' ? 'tool'
      : type ?? 'user';
    const out: Record<string, unknown> = { role: oaiRole, content: m.content ?? null };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.name) out.name = m.name;
    return out;
  }
  return null;
}

/** Serialize the LangChain messages array to an OpenAI Chat Completion request body. */
export function serializeMessagesToOpenAiBody(messages: unknown[], model?: string): string {
  const oaiMessages = messages
    .map(lcMsgToOpenAi)
    .filter((m): m is Record<string, unknown> => m !== null);
  try {
    return JSON.stringify({ model: model ?? 'unknown', messages: oaiMessages });
  } catch {
    return JSON.stringify({ model: model ?? 'unknown', messages: [] });
  }
}

/** Serialize a LangChain AIMessage to an OpenAI Chat Completion response body. */
export function serializeResponseToOpenAiBody(response: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ai: any = (response as any)?.message ?? response;
  const content = ai?.content ?? null;
  const toolCalls: unknown[] = ai?.tool_calls ?? [];
  const usage = (ai?.usage_metadata ?? {}) as Record<string, unknown>;
  const model: string =
    ((ai?.response_metadata ?? {}) as Record<string, unknown>).model_name as string ?? 'unknown';

  const msg: Record<string, unknown> = {
    role: 'assistant',
    content: typeof content === 'string' ? content : JSON.stringify(content),
  };
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;

  try {
    return JSON.stringify({
      choices: [{ message: msg, finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop' }],
      usage: {
        prompt_tokens: usage.input_tokens ?? 0,
        completion_tokens: usage.output_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
      },
      model,
    });
  } catch {
    return JSON.stringify({ choices: [{ message: msg }] });
  }
}

// ── _extract_response_metadata ────────────────────────────────────────────────

export interface ResponseMetadata {
  llm_model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  has_tool_calls: boolean;
  completion: string | null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Extract token counts, model name, and completion text from a LangChain
 * AIMessage. Mirrors _extract_response_metadata in middleware_hooks.py.
 * Missing values are explicit `null` (present key) rather than an absent
 * key, so the field always survives serialization.
 */
export function extractResponseMetadata(response: unknown): ResponseMetadata {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let aiMsg: any = response;
  if (aiMsg?.message != null) aiMsg = aiMsg.message;

  const meta = (aiMsg?.response_metadata ?? {}) as Record<string, unknown>;
  const modelName = meta.model_name ?? meta.model;
  const llm_model = typeof modelName === 'string' ? modelName : null;

  const usage = (aiMsg?.usage_metadata ?? {}) as Record<string, unknown>;
  const input_tokens = asFiniteNumber(usage.input_tokens ?? usage.prompt_tokens);
  const output_tokens = asFiniteNumber(usage.output_tokens ?? usage.completion_tokens);
  const total_tokens =
    input_tokens != null || output_tokens != null
      ? (input_tokens ?? 0) + (output_tokens ?? 0)
      : null;

  const content = aiMsg?.content;
  let completion: string | null = null;
  if (typeof content === 'string') {
    completion = content;
  } else if (Array.isArray(content)) {
    const parts = (content as unknown[])
      .filter(
        (p): p is Record<string, unknown> =>
          typeof p === 'object' && p !== null &&
          (p as Record<string, unknown>).type === 'text' &&
          typeof (p as Record<string, unknown>).text === 'string' &&
          ((p as Record<string, unknown>).text as string).length > 0,
      )
      .map((p) => String(p.text));
    completion = parts.length > 0 ? parts.join(' ') : null;
  }

  return {
    llm_model,
    input_tokens,
    output_tokens,
    total_tokens,
    has_tool_calls: Boolean(aiMsg?.tool_calls?.length),
    completion,
  };
}
