"use strict";
/**
 * OpenBoxLangChainMiddleware — TypeScript port of middleware.py.
 *
 * The Python SDK subclasses AgentMiddleware; here we expose the same four
 * lifecycle methods (beforeAgent / afterAgent / wrapModelCall / wrapToolCall)
 * as plain async functions the node calls directly since n8n has no middleware
 * hook infrastructure.
 *
 * Per-invocation mutable state mirrors the Python class instance fields
 * (_workflow_id, _run_id, _first_llm_call, _pre_screen_response) so all
 * handler functions can be exact ports of their Python counterparts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenBoxLangChainMiddleware = void 0;
const client_1 = require("./client");
const config_1 = require("./config");
const hook_handlers_1 = require("./hook_handlers");
const span_processor_1 = require("./span_processor");
const node_instrumentation_1 = require("./node_instrumentation");
const tool_hook_1 = require("./tool_hook");
class OpenBoxLangChainMiddleware {
    // Per-invocation state — reset by beforeAgent() on every call
    _workflowId = '';
    _runId = '';
    _workflowType;
    _config;
    _client;
    constructor(options, executeFunctions) {
        this._config = (0, config_1.mergeConfig)(options);
        this._workflowType = options.agentName ?? 'LangChainRun';
        this._client = new client_1.GovernanceClient(executeFunctions, '');
        // Ensure fetch/http spans to the OpenBox API itself are never captured
        // to avoid infinite loops (mirrors `ignored_urls` in Python SDK setup).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const apiUrl = (global.process?.env?.OPENBOX_API_URL ?? 'https://core.openbox.ai').replace(/\/+$/, '');
        (0, span_processor_1.addIgnoredPrefix)(apiUrl);
        (0, span_processor_1.setupSpanProcessorInstrumentation)({ http: this._config.instrumentHttp });
        (0, node_instrumentation_1.setupNodeHookInstrumentation)({
            fileIo: this._config.instrumentFileIo,
            databases: this._config.instrumentDatabases,
        });
    }
    // ── Lifecycle hooks ────────────────────────────────────────────────────────
    /**
     * before_agent() — session setup.
     * threadId replaces Python's runtime.config.configurable.thread_id.
     */
    async beforeAgent(state, threadId) {
        return (0, hook_handlers_1.handleBeforeAgent)(this, state, threadId);
    }
    /** after_agent() — session close. Returns the WorkflowCompleted verdict. */
    async afterAgent(state, failedWith) {
        return (0, hook_handlers_1.handleAfterAgent)(this, state, failedWith);
    }
    /**
     * wrap_model_call() — LLM governance.
     * messages is the full array passed to model.invoke().
     * handler is the thunk that performs the actual model call.
     */
    async wrapModelCall(messages, handler) {
        return (0, hook_handlers_1.handleWrapModelCall)(this, messages, handler);
    }
    /**
     * wrap_tool_call() — tool governance.
     * In the Python SDK the full ToolCallRequest is passed; here we decompose
     * it so the node doesn't need to construct the LangChain request object.
     */
    async wrapToolCall(toolName, toolArgs, handler) {
        return (0, tool_hook_1.handleWrapToolCall)(this, toolName, toolArgs, handler);
    }
    /**
     * wrap_memory_op() — scope memory load/save inside a short-lived activity
     * so database queries inside the memory node (e.g. pg Chat Memory) generate
     * db_query spans visible on the OpenBox dashboard.
     */
    async wrapMemoryOp(opType, fn) {
        return (0, hook_handlers_1.handleWrapMemoryOp)(this, opType, fn);
    }
}
exports.OpenBoxLangChainMiddleware = OpenBoxLangChainMiddleware;
