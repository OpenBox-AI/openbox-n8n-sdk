"use strict";
/**
 * Hook helper functions — TypeScript port of middleware_hooks.py.
 *
 * _base_event_fields, _evaluate, _extract_last_user_message,
 * _extract_prompt_from_messages, _apply_pii_redaction,
 * _extract_response_metadata.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.baseEventFields = baseEventFields;
exports.evaluate = evaluate;
exports.extractGovernanceBlocked = extractGovernanceBlocked;
exports.extractLastUserMessage = extractLastUserMessage;
exports.extractPromptFromMessages = extractPromptFromMessages;
exports.applyPiiRedaction = applyPiiRedaction;
exports.serializeMessagesToOpenAiBody = serializeMessagesToOpenAiBody;
exports.serializeResponseToOpenAiBody = serializeResponseToOpenAiBody;
exports.extractResponseMetadata = extractResponseMetadata;
const types_1 = require("./types");
const verdict_1 = require("./verdict");
// ── _base_event_fields ────────────────────────────────────────────────────────
function baseEventFields(mw) {
    return {
        source: 'workflow-telemetry',
        workflow_id: mw._workflowId,
        run_id: mw._runId,
        workflow_type: mw._workflowType,
        task_queue: mw._config.taskQueue,
        timestamp: (0, types_1.rfc3339Now)(),
        session_id: mw._config.sessionId,
    };
}
// ── _evaluate ─────────────────────────────────────────────────────────────────
async function evaluate(mw, event) {
    return mw._client.evaluateEvent(event);
}
// ── _extract_governance_blocked ──────────────────────────────────────────────
function extractGovernanceBlocked(err) {
    const seen = new Set();
    let current = err;
    while (current != null && !seen.has(current)) {
        seen.add(current);
        if (current instanceof verdict_1.GovernanceBlockedError)
            return current;
        if (typeof current === 'object') {
            const record = current;
            current = record.cause ?? record.context;
        }
        else {
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
function extractLastUserMessage(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (Array.isArray(msg) && msg.length === 2) {
            if (msg[0] === 'user' || msg[0] === 'human') {
                return typeof msg[1] === 'string' ? msg[1] : null;
            }
        }
        else if (msg !== null && typeof msg === 'object') {
            const m = msg;
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
function extractPromptFromMessages(messages) {
    if (!Array.isArray(messages))
        return '';
    const parts = [];
    for (const msg of messages) {
        appendHumanContent(msg, parts);
    }
    return parts.join('\n');
}
function appendHumanContent(msg, parts) {
    let role = null;
    let content = null;
    if (Array.isArray(msg) && msg.length === 2) {
        role = msg[0];
        content = msg[1];
    }
    else if (msg !== null && typeof msg === 'object') {
        const m = msg;
        role = m.type ?? m.role;
        content = m.content;
    }
    if (role !== 'human' && role !== 'user' && role !== 'generic')
        return;
    if (typeof content === 'string') {
        parts.push(content);
    }
    else if (Array.isArray(content)) {
        for (const part of content) {
            if (typeof part === 'object' && part !== null &&
                part.type === 'text') {
                const text = part.text;
                if (typeof text === 'string')
                    parts.push(text);
            }
        }
    }
}
// ── _apply_pii_redaction ──────────────────────────────────────────────────────
/**
 * Mutate the last human message in messages with the redacted text returned
 * by Core's guardrails. Mirrors Python SDK's _apply_pii_redaction exactly.
 */
function applyPiiRedaction(messages, redactedInput) {
    let redactedText = null;
    if (Array.isArray(redactedInput) && redactedInput.length > 0) {
        const first = redactedInput[0];
        if (typeof first === 'object' && first !== null) {
            redactedText = first.prompt ?? null;
        }
        else if (typeof first === 'string') {
            redactedText = first;
        }
    }
    else if (typeof redactedInput === 'string') {
        redactedText = redactedInput;
    }
    if (!redactedText)
        return;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (Array.isArray(msg) && msg.length === 2 && (msg[0] === 'human' || msg[0] === 'user')) {
            messages[i] = [msg[0], redactedText];
            return;
        }
        if (msg !== null && typeof msg === 'object') {
            const m = msg;
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
function lcMsgToOpenAi(msg) {
    if (Array.isArray(msg) && msg.length === 2) {
        const [role, content] = msg;
        const oaiRole = role === 'human' || role === 'user' ? 'user' : role;
        return { role: oaiRole, content };
    }
    if (msg !== null && typeof msg === 'object') {
        const m = msg;
        const type = m.type;
        const oaiRole = type === 'human' ? 'user'
            : type === 'ai' ? 'assistant'
                : type === 'tool' ? 'tool'
                    : type ?? 'user';
        const out = { role: oaiRole, content: m.content ?? null };
        if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0)
            out.tool_calls = m.tool_calls;
        if (m.tool_call_id)
            out.tool_call_id = m.tool_call_id;
        if (m.name)
            out.name = m.name;
        return out;
    }
    return null;
}
/** Serialize the LangChain messages array to an OpenAI Chat Completion request body. */
function serializeMessagesToOpenAiBody(messages, model) {
    const oaiMessages = messages
        .map(lcMsgToOpenAi)
        .filter((m) => m !== null);
    try {
        return JSON.stringify({ model: model ?? 'unknown', messages: oaiMessages });
    }
    catch {
        return JSON.stringify({ model: model ?? 'unknown', messages: [] });
    }
}
/** Serialize a LangChain AIMessage to an OpenAI Chat Completion response body. */
function serializeResponseToOpenAiBody(response) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ai = response?.message ?? response;
    const content = ai?.content ?? null;
    const toolCalls = ai?.tool_calls ?? [];
    const usage = (ai?.usage_metadata ?? {});
    const model = (ai?.response_metadata ?? {}).model_name ?? 'unknown';
    const msg = {
        role: 'assistant',
        content: typeof content === 'string' ? content : JSON.stringify(content),
    };
    if (toolCalls.length > 0)
        msg.tool_calls = toolCalls;
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
    }
    catch {
        return JSON.stringify({ choices: [{ message: msg }] });
    }
}
/**
 * Extract token counts, model name, and completion text from a LangChain
 * AIMessage. Mirrors _extract_response_metadata in middleware_hooks.py.
 */
function extractResponseMetadata(response) {
    const result = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let aiMsg = response;
    if (aiMsg?.message != null)
        aiMsg = aiMsg.message;
    if (aiMsg?.response_metadata) {
        const meta = aiMsg.response_metadata;
        const model = meta.model_name ?? meta.model;
        if (typeof model === 'string')
            result.llm_model = model;
    }
    const usage = (aiMsg?.usage_metadata ?? {});
    const inp = (usage.input_tokens ?? usage.prompt_tokens);
    const out = (usage.output_tokens ?? usage.completion_tokens);
    result.input_tokens = inp;
    result.output_tokens = out;
    result.total_tokens =
        inp != null || out != null ? (inp ?? 0) + (out ?? 0) : undefined;
    const content = aiMsg?.content;
    if (typeof content === 'string') {
        result.completion = content || undefined;
    }
    else if (Array.isArray(content)) {
        const parts = content
            .filter((p) => typeof p === 'object' && p !== null &&
            p.type === 'text')
            .map((p) => String(p.text ?? ''));
        const joined = parts.join(' ');
        result.completion = joined || undefined;
    }
    result.has_tool_calls = Boolean(aiMsg?.tool_calls?.length);
    return result;
}
