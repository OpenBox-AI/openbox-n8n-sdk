"use strict";
/**
 * OpenBox Agent node for n8n.
 *
 * Uses OpenBoxLangChainMiddleware — a 1:1 TypeScript port of the Python SDK
 * (openbox-langchain-sdk-python) — to govern the agent lifecycle:
 *
 *   beforeAgent()      → SignalReceived + WorkflowStarted + pre-screen LLMStarted
 *   wrapModelCall()    → LLMStarted → PII redaction → model.invoke → LLMCompleted
 *   wrapToolCall()     → ToolStarted → tool.invoke → ToolCompleted
 *   afterAgent()       → WorkflowCompleted
 *
 * The node itself only handles n8n plumbing (inputs, credentials, prompt
 * resolution, memory, agent loop). All governance logic lives in the SDK.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenBoxAgent = void 0;
const n8n_workflow_1 = require("n8n-workflow");
const credential_test_1 = require("../../shared/credential-test");
const langchain_1 = require("../../shared/langchain");
// ── ToolMessage factory ───────────────────────────────────────────────────────
// @langchain/core is always present in n8n's runtime.
const LangchainToolMessage = (() => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('@langchain/core/messages').ToolMessage;
    }
    catch {
        return null;
    }
})();
function makeToolMessage(content, tool_call_id, name) {
    if (LangchainToolMessage)
        return new LangchainToolMessage({ content, tool_call_id, name });
    return { role: 'tool', content, tool_call_id, name };
}
function extractTextContent(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('');
    }
    return content == null ? '' : String(content);
}
// ── Node ──────────────────────────────────────────────────────────────────────
class OpenBoxAgent {
    description = {
        displayName: 'OpenBox: Agent',
        name: 'openBoxAgent',
        icon: 'file:OB_logomark.png',
        group: ['transform'],
        version: 1,
        subtitle: '={{$parameter["options"]["systemMessage"] ? "Custom System Prompt" : ""}}',
        description: 'AI agent with OpenBox governance. Connect a Chat Model, Memory, and Tools as sub-nodes. Sends the same lifecycle events as the LangChain Python SDK.',
        defaults: { name: 'OpenBox: Agent' },
        inputs: [
            n8n_workflow_1.NodeConnectionTypes.Main,
            {
                type: n8n_workflow_1.NodeConnectionTypes.AiLanguageModel,
                displayName: 'Chat Model',
                required: true,
                maxConnections: 1,
            },
            {
                type: n8n_workflow_1.NodeConnectionTypes.AiMemory,
                displayName: 'Memory',
                required: false,
                maxConnections: 1,
            },
            {
                type: n8n_workflow_1.NodeConnectionTypes.AiTool,
                displayName: 'Tool',
                required: false,
            },
        ],
        outputs: [n8n_workflow_1.NodeConnectionTypes.Main],
        credentials: [
            { name: 'openBoxApi', required: false, testedBy: 'openBoxApiCredentialTest' },
        ],
        properties: [
            {
                displayName: 'Prompt',
                name: 'promptType',
                type: 'options',
                options: [
                    {
                        name: 'Take from Previous Node Automatically',
                        value: 'auto',
                        description: 'Looks for chatInput, text, message, input, query, or the first string field',
                    },
                    { name: 'Define Below', value: 'define' },
                ],
                default: 'auto',
                noDataExpression: true,
            },
            {
                displayName: 'Text',
                name: 'text',
                type: 'string',
                required: true,
                typeOptions: { rows: 2 },
                default: '',
                displayOptions: { show: { promptType: ['define'] } },
            },
            {
                displayName: 'Options',
                name: 'options',
                type: 'collection',
                placeholder: 'Add Option',
                default: {},
                options: [
                    {
                        displayName: 'System Message',
                        name: 'systemMessage',
                        type: 'string',
                        typeOptions: { rows: 4 },
                        default: 'You are a helpful assistant. Use the tools available to you to answer questions accurately.',
                    },
                    {
                        displayName: 'Max Iterations',
                        name: 'maxIterations',
                        type: 'number',
                        typeOptions: { minValue: 1, maxValue: 50 },
                        default: 10,
                    },
                ],
            },
        ],
    };
    methods = {
        credentialTest: {
            openBoxApiCredentialTest: credential_test_1.testOpenBoxCredential,
        },
    };
    async execute() {
        const items = this.getInputData();
        const output = [];
        // ── Retrieve connected sub-nodes ─────────────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const model = (await this.getInputConnectionData(n8n_workflow_1.NodeConnectionTypes.AiLanguageModel, 0));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tools = (await this.getInputConnectionData(n8n_workflow_1.NodeConnectionTypes.AiTool, 0)) ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const memory = (await this.getInputConnectionData(n8n_workflow_1.NodeConnectionTypes.AiMemory, 0)) ?? null;
        if (!model) {
            throw new n8n_workflow_1.NodeOperationError(this.getNode(), 'No Chat Model connected. Drag a language model sub-node (e.g. "OpenAI Chat Model") into the Chat Model input.');
        }
        const options = this.getNodeParameter('options', 0, {});
        const systemMessage = options.systemMessage ?? 'You are a helpful assistant.';
        const maxIterations = options.maxIterations ?? 10;
        const promptType = this.getNodeParameter('promptType', 0, 'auto');
        const workflowType = `n8n.Agent.${this.getNode().name.replace(/\s+/g, '_')}`;
        // Bind tools to model once (immutable across items)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const boundModel = tools.length > 0 ? model.bindTools(tools) : model;
        // ── Build middleware (one instance per execute() call, reset per item) ───
        const middleware = new langchain_1.OpenBoxLangChainMiddleware({ agentName: workflowType, taskQueue: 'n8n' }, this);
        for (let i = 0; i < items.length; i++) {
            const itemJson = items[i].json;
            // ── Resolve session_id ─────────────────────────────────────────────────
            if (typeof itemJson.sessionId === 'string') {
                middleware._config.sessionId = itemJson.sessionId;
            }
            // ── Resolve prompt ─────────────────────────────────────────────────────
            let userMessage;
            if (promptType === 'define') {
                userMessage = String(this.getNodeParameter('text', i, '')).trim();
            }
            else {
                const CANDIDATES = ['chatInput', 'text', 'message', 'input', 'query', 'prompt'];
                const hit = CANDIDATES.find((f) => typeof itemJson[f] === 'string' && itemJson[f].trim() !== '');
                if (hit) {
                    userMessage = itemJson[hit].trim();
                }
                else {
                    const anyStr = Object.keys(itemJson).find((k) => typeof itemJson[k] === 'string' && itemJson[k].trim() !== '');
                    userMessage = anyStr ? itemJson[anyStr].trim() : '';
                }
            }
            if (!userMessage) {
                throw new n8n_workflow_1.NodeOperationError(this.getNode(), `No prompt found on item ${i}. Connect a Chat Trigger or set Prompt to "Define Below".`, { itemIndex: i });
            }
            // ── threadId mirrors Python SDK's configurable.thread_id ──────────────
            const execId = this.getExecutionId();
            const threadId = `${String(this.getWorkflow().id ?? 'wf')}-${execId}`;
            // ══════════════════════════════════════════════════════════════════════
            // before_agent — SignalReceived + WorkflowStarted + pre-screen
            // Pre-screens on the raw user message only; chat history is added below.
            // ══════════════════════════════════════════════════════════════════════
            try {
                await middleware.beforeAgent({ messages: [['human', userMessage]] }, threadId);
            }
            catch (err) {
                mapGovernanceError(err, this, i);
                throw err;
            }
            // ── Load memory (after beforeAgent so middleware IDs are set) ──────────
            // Wrapped in wrapMemoryOp so pg queries inside the memory node are
            // captured as db_query spans under a memory_load activity.
            let chatHistory = [];
            if (memory) {
                try {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const vars = await middleware.wrapMemoryOp('memory_load', () => memory.loadMemoryVariables({ input: userMessage }));
                    chatHistory = (vars.chat_history ?? vars.history ?? []);
                }
                catch { /* non-fatal */ }
            }
            const messages = [
                ['system', systemMessage],
                ...chatHistory,
                ['human', userMessage],
            ];
            let finalOutput = '';
            let iterations = 0;
            let toolCallCount = 0;
            // ══════════════════════════════════════════════════════════════════════
            // Agent loop — each iteration calls wrapModelCall / wrapToolCall
            // ══════════════════════════════════════════════════════════════════════
            const cancelSignal = typeof this.getExecutionCancelSignal === 'function'
                ? this.getExecutionCancelSignal()
                : undefined;
            agentLoop: for (let iter = 0; iter < maxIterations; iter++) {
                iterations = iter + 1;
                // ── wrapModelCall ──────────────────────────────────────────────────
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                let response;
                try {
                    response = await middleware.wrapModelCall(messages, () => boundModel.invoke(messages, { signal: cancelSignal }));
                }
                catch (err) {
                    mapGovernanceError(err, this, i);
                    throw err;
                }
                const toolCalls = response?.tool_calls ?? [];
                // No tool calls → final response
                if (!toolCalls.length) {
                    finalOutput = extractTextContent(response?.content);
                    messages.push(response);
                    break agentLoop;
                }
                messages.push(response); // AIMessage with tool_calls
                // ── wrapToolCall per tool ──────────────────────────────────────────
                for (const toolCall of toolCalls) {
                    toolCallCount++;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const tool = tools.find((t) => t.name === toolCall.name);
                    if (!tool) {
                        throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Tool "${toolCall.name}" is not connected.`, { itemIndex: i });
                    }
                    let toolResult;
                    try {
                        const raw = await middleware.wrapToolCall(toolCall.name, toolCall.args, () => tool.invoke(toolCall.args));
                        toolResult = typeof raw === 'string' ? raw : JSON.stringify(raw);
                    }
                    catch (err) {
                        mapGovernanceError(err, this, i);
                        throw err;
                    }
                    messages.push(makeToolMessage(toolResult, toolCall.id, toolCall.name));
                }
            }
            if (!finalOutput && iterations >= maxIterations) {
                finalOutput = `[Agent reached max iterations (${maxIterations}) without a final response.]`;
            }
            // ══════════════════════════════════════════════════════════════════════
            // after_agent — WorkflowCompleted
            // ══════════════════════════════════════════════════════════════════════
            let completedVerdict;
            try {
                completedVerdict = await middleware.afterAgent({ messages });
            }
            catch (err) {
                mapGovernanceError(err, this, i);
                throw err;
            }
            // Apply output redaction from WorkflowCompleted guardrails
            const gr = completedVerdict?.guardrails_result ??
                completedVerdict?.guardrailsResult;
            if (gr?.redacted_input && gr.input_type === 'activity_output') {
                finalOutput = String(gr.redacted_input);
            }
            // ── Save to memory ─────────────────────────────────────────────────────
            if (memory) {
                try {
                    await middleware.wrapMemoryOp('memory_save', () => memory.saveContext({ input: userMessage }, { output: finalOutput }));
                }
                catch { /* non-fatal */ }
            }
            output.push({
                json: {
                    ...itemJson,
                    output: finalOutput,
                    _openbox: {
                        workflowId: middleware._workflowId,
                        runId: middleware._runId,
                        toolCallCount,
                        iterations,
                    },
                },
                pairedItem: { item: i },
            });
        }
        return [output];
    }
}
exports.OpenBoxAgent = OpenBoxAgent;
// ── Governance error → NodeOperationError ─────────────────────────────────────
function mapGovernanceError(err, ctx, itemIndex) {
    if (err instanceof langchain_1.GovernanceHaltError) {
        throw new n8n_workflow_1.NodeOperationError(ctx.getNode(), err.message, { itemIndex });
    }
    if (err instanceof langchain_1.GovernanceBlockedError) {
        throw new n8n_workflow_1.NodeOperationError(ctx.getNode(), `OpenBox governance requires approval`, { itemIndex, description: err.message });
    }
}
