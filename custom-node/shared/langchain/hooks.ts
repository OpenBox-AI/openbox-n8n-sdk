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

// ── _base_event_fields ────────────────────────────────────────────────────────

export function baseEventFields(mw: OpenBoxLangChainMiddleware): {
  source: 'workflow-telemetry';
  workflow_id: string;
  run_id: string;
  workflow_type: string;
  task_queue: string;
  timestamp: string;
  session_id: string | undefined;
} {
  return {
    source: 'workflow-telemetry',
    workflow_id: mw._workflowId,
    run_id: mw._runId,
    workflow_type: mw._workflowType,
    task_queue: mw._config.taskQueue,
    timestamp: rfc3339Now(),
    session_id: mw._config.sessionId,
  };
}

// ── _evaluate ─────────────────────────────────────────────────────────────────

export async function evaluate(
  mw: OpenBoxLangChainMiddleware,
  event: LangChainGovernanceEvent,
): Promise<GovernanceVerdictResponse | null> {
  return mw._client.evaluateEvent(event);
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

// ── _extract_last_user_message ────────────────────────────────────────────────

/**
 * Find the last human/user message in an agent state messages array.
 * Handles both tuple format ['human', text] and LangChain message objects.
 */
export function extractLastUserMessage(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (Array.isArray(msg) && msg.length === 2) {
      if (msg[0] === 'user' || msg[0] === 'human') {
        return typeof msg[1] === 'string' ? msg[1] : null;
      }
    } else if (msg !== null && typeof msg === 'object') {
      const m = msg as Record<string, unknown>;
      const role = m.type ?? m.role;
      if (role === 'human' || role === 'user') {
        const content = m.content;
        return typeof content === 'string' ? content : null;
      }
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
  let role: unknown = null;
  let content: unknown = null;

  if (Array.isArray(msg) && msg.length === 2) {
    role = msg[0];
    content = msg[1];
  } else if (msg !== null && typeof msg === 'object') {
    const m = msg as Record<string, unknown>;
    role = m.type ?? m.role;
    content = m.content;
  }

  if (role !== 'human' && role !== 'user' && role !== 'generic') return;

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
 * Mutate the last human message in messages with the redacted text returned
 * by Core's guardrails. Mirrors Python SDK's _apply_pii_redaction exactly.
 */
export function applyPiiRedaction(messages: unknown[], redactedInput: unknown): void {
  let redactedText: string | null = null;

  if (Array.isArray(redactedInput) && redactedInput.length > 0) {
    const first = redactedInput[0];
    if (typeof first === 'object' && first !== null) {
      redactedText = (first as Record<string, string>).prompt ?? null;
    } else if (typeof first === 'string') {
      redactedText = first;
    }
  } else if (typeof redactedInput === 'string') {
    redactedText = redactedInput;
  }

  if (!redactedText) return;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (Array.isArray(msg) && msg.length === 2 && (msg[0] === 'human' || msg[0] === 'user')) {
      messages[i] = [msg[0], redactedText];
      return;
    }
    if (msg !== null && typeof msg === 'object') {
      const m = msg as Record<string, unknown>;
      const role = m.type ?? m.role;
      if ((role === 'human' || role === 'user' || role === 'generic') && 'content' in m) {
        m.content = redactedText;
        return;
      }
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
  llm_model?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  has_tool_calls?: boolean;
  completion?: string;
}

/**
 * Extract token counts, model name, and completion text from a LangChain
 * AIMessage. Mirrors _extract_response_metadata in middleware_hooks.py.
 */
export function extractResponseMetadata(response: unknown): ResponseMetadata {
  const result: ResponseMetadata = {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let aiMsg: any = response;
  if (aiMsg?.message != null) aiMsg = aiMsg.message;

  if (aiMsg?.response_metadata) {
    const meta = aiMsg.response_metadata as Record<string, unknown>;
    const model = meta.model_name ?? meta.model;
    if (typeof model === 'string') result.llm_model = model;
  }

  const usage = (aiMsg?.usage_metadata ?? {}) as Record<string, unknown>;
  const inp = (usage.input_tokens ?? usage.prompt_tokens) as number | undefined;
  const out = (usage.output_tokens ?? usage.completion_tokens) as number | undefined;
  result.input_tokens = inp;
  result.output_tokens = out;
  result.total_tokens =
    inp != null || out != null ? (inp ?? 0) + (out ?? 0) : undefined;

  const content = aiMsg?.content;
  if (typeof content === 'string') {
    result.completion = content || undefined;
  } else if (Array.isArray(content)) {
    const parts = (content as unknown[])
      .filter(
        (p): p is Record<string, unknown> =>
          typeof p === 'object' && p !== null &&
          (p as Record<string, unknown>).type === 'text',
      )
      .map((p) => String(p.text ?? ''));
    const joined = parts.join(' ');
    result.completion = joined || undefined;
  }

  result.has_tool_calls = Boolean(aiMsg?.tool_calls?.length);
  return result;
}
