"use strict";
/**
 * Hook helper functions — TypeScript port of middleware_hooks.py.
 *
 * _base_event_fields, _evaluate, _extract_last_user_message,
 * _extract_prompt_from_messages, _apply_pii_redaction,
 * _extract_response_metadata.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.turnFromError = turnFromError;
exports.baseEventFields = baseEventFields;
exports.buildEvent = buildEvent;
exports.evaluate = evaluate;
exports.sendOrphanClosure = sendOrphanClosure;
exports.extractGovernanceBlocked = extractGovernanceBlocked;
exports.hasHumanTurn = hasHumanTurn;
exports.extractLastUserMessage = extractLastUserMessage;
exports.extractPromptFromMessages = extractPromptFromMessages;
exports.applyPiiRedaction = applyPiiRedaction;
exports.serializeMessagesToOpenAiBody = serializeMessagesToOpenAiBody;
exports.serializeResponseToOpenAiBody = serializeResponseToOpenAiBody;
exports.extractResponseMetadata = extractResponseMetadata;
const types_1 = require("./types");
const verdict_1 = require("./verdict");
const error_info_1 = require("./error-info");
/**
 * Recover the turn identity from an error thrown by beforeAgent(). Governance
 * failures (block/halt, or a hard API error) can throw before beforeAgent
 * returns its Turn — the caller still needs workflow_id/run_id to call
 * afterAgent() and close the workflow, so beforeAgent attaches it to the
 * error before rethrowing.
 */
function turnFromError(err) {
    if (err == null || typeof err !== 'object')
        return undefined;
    const turn = err.__obTurn;
    return turn;
}
function baseEventFields(mw, turn) {
    return {
        source: 'workflow-telemetry',
        workflow_id: turn.workflowId,
        run_id: turn.runId,
        workflow_type: mw._workflowType,
        task_queue: mw._config.taskQueue,
        timestamp: (0, types_1.rfc3339Now)(),
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
function buildEvent(mw, turn, eventType, activityId, activityType, 
// Partial<LangChainGovernanceEvent> (not Record<string, unknown>) so that,
// e.g., `error: someBareString` fails to compile here the same way it
// would in a direct object literal — a plain Record<string, unknown> would
// let a bare string slip past the ErrorInfo typing via this parameter.
fields = {}) {
    return {
        ...baseEventFields(mw, turn),
        event_type: eventType,
        activity_id: activityId,
        activity_type: activityType,
        ...fields,
    };
}
// ── _evaluate ─────────────────────────────────────────────────────────────────
async function evaluate(mw, event) {
    return mw._client.evaluateEvent(event, mw._config.onApiError);
}
/**
 * Close an orphaned activity row (a start event with no matching completion)
 * with a failed ActivityCompleted, using the SAME activity id, before the
 * caller rethrows a gate-enforcement error. Best-effort — a failure here must
 * never mask the original governance error.
 */
async function sendOrphanClosure(mw, turn, completedEventType, activityId, activityType, err) {
    try {
        await evaluate(mw, buildEvent(mw, turn, completedEventType, activityId, activityType, {
            status: 'failed',
            error: (0, error_info_1.toErrorInfo)(err),
        }));
    }
    catch {
        // non-fatal — closure telemetry must not mask the original error
    }
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
// ── message role / shape helpers ──────────────────────────────────────────────
/**
 * Resolve a message's role. Tries a real LangChain message instance's
 * `.getType()` method first (HumanMessage/AIMessage/ToolMessage etc. — the
 * shape produced by model.invoke()/ToolMessage construction in the n8n node),
 * then falls back to a plain `.type`/`.role` property for tuple/dict messages.
 */
function messageRole(msg) {
    if (Array.isArray(msg) && msg.length === 2)
        return msg[0];
    if (msg !== null && typeof msg === 'object') {
        const m = msg;
        if (typeof m.getType === 'function') {
            try {
                return m.getType.call(m);
            }
            catch {
                // fall through to property access
            }
        }
        return m.type ?? m.role;
    }
    return null;
}
function messageContent(msg) {
    if (Array.isArray(msg) && msg.length === 2)
        return msg[1];
    if (msg !== null && typeof msg === 'object')
        return msg.content;
    return null;
}
/**
 * True whenever there is a human/user/generic turn at all, independent of
 * whether the extracted text is empty or the content is multimodal. Used to
 * make sure an empty/non-text turn is still governed rather than silently
 * skipped. Role set matches extractLastUserMessage/appendHumanContent/
 * applyPiiRedaction — keep these consistent.
 */
function hasHumanTurn(messages) {
    if (!Array.isArray(messages))
        return false;
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
function extractLastUserMessage(messages) {
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
    const role = messageRole(msg);
    if (role !== 'human' && role !== 'user' && role !== 'generic')
        return;
    const content = messageContent(msg);
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
 * Coerce Core's redacted-input payload to plain text. Accepts a bare string,
 * or an array whose first element is a string or an object carrying
 * `.prompt` or `.text` (Core has used both shapes historically).
 */
function coerceRedactedText(redactedInput) {
    if (typeof redactedInput === 'string')
        return redactedInput || null;
    if (Array.isArray(redactedInput) && redactedInput.length > 0) {
        const first = redactedInput[0];
        if (typeof first === 'string')
            return first || null;
        if (typeof first === 'object' && first !== null) {
            const rec = first;
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
function redactContent(content, redactedText) {
    if (typeof content === 'string')
        return redactedText;
    if (Array.isArray(content)) {
        let replaced = false;
        return content.map((part) => {
            if (typeof part === 'object' && part !== null && part.type === 'text') {
                const block = part;
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
function applyPiiRedaction(messages, redactedInput) {
    const redactedText = coerceRedactedText(redactedInput);
    if (!redactedText)
        return;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const role = messageRole(msg);
        if (role !== 'human' && role !== 'user' && role !== 'generic')
            continue;
        if (Array.isArray(msg) && msg.length === 2) {
            messages[i] = [msg[0], redactContent(msg[1], redactedText)];
            return;
        }
        if (msg !== null && typeof msg === 'object' && 'content' in msg) {
            msg.content = redactContent(msg.content, redactedText);
            return;
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
function asFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
/**
 * Extract token counts, model name, and completion text from a LangChain
 * AIMessage. Mirrors _extract_response_metadata in middleware_hooks.py.
 * Missing values are explicit `null` (present key) rather than an absent
 * key, so the field always survives serialization.
 */
function extractResponseMetadata(response) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let aiMsg = response;
    if (aiMsg?.message != null)
        aiMsg = aiMsg.message;
    const meta = (aiMsg?.response_metadata ?? {});
    const modelName = meta.model_name ?? meta.model;
    const llm_model = typeof modelName === 'string' ? modelName : null;
    const usage = (aiMsg?.usage_metadata ?? {});
    const input_tokens = asFiniteNumber(usage.input_tokens ?? usage.prompt_tokens);
    const output_tokens = asFiniteNumber(usage.output_tokens ?? usage.completion_tokens);
    const total_tokens = input_tokens != null || output_tokens != null
        ? (input_tokens ?? 0) + (output_tokens ?? 0)
        : null;
    const content = aiMsg?.content;
    let completion = null;
    if (typeof content === 'string') {
        completion = content;
    }
    else if (Array.isArray(content)) {
        const parts = content
            .filter((p) => typeof p === 'object' && p !== null &&
            p.type === 'text' &&
            typeof p.text === 'string' &&
            p.text.length > 0)
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
