"use strict";
/**
 * OpenBoxLangChainMiddleware — TypeScript port of middleware.py.
 *
 * The Python SDK subclasses AgentMiddleware; here we expose the same four
 * lifecycle methods (beforeAgent / afterAgent / wrapModelCall / wrapToolCall)
 * as plain async functions the node calls directly since n8n has no middleware
 * hook infrastructure.
 *
 * Turn identity (workflowId/runId) is NEVER stored as mutable state on this
 * instance — beforeAgent() returns a `Turn` value that the caller threads
 * through every subsequent call. This mirrors openbox-langchain-sdk-ts's
 * turn-state.ts design: identity that lives on a shared/reused instance is
 * exactly the kind of state a future concurrent-execution refactor could
 * accidentally clobber.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenBoxLangChainMiddleware = void 0;
const client_1 = require("./client");
const config_1 = require("./config");
const hook_handlers_1 = require("./hook_handlers");
const span_processor_1 = require("./span_processor");
const node_instrumentation_1 = require("./node_instrumentation");
const tool_hook_1 = require("./tool_hook");
const DEFAULT_OPENBOX_URL = 'https://core.openbox.ai';
class OpenBoxLangChainMiddleware {
    _workflowType;
    _config;
    _client;
    constructor(options, executeFunctions) {
        this._config = (0, config_1.mergeConfig)(options);
        this._workflowType = options.agentName ?? 'LangChainRun';
        this._client = new client_1.GovernanceClient(executeFunctions, '', this._config.governanceTimeout * 1000);
        // Ensure fetch/http spans to the OpenBox API itself are never captured
        // to avoid infinite loops (mirrors `ignored_urls` in Python SDK setup).
        // The credential's actual URL (which may be a self-hosted Core) is added
        // as an additional ignored prefix once known, in handleBeforeAgent.
        (0, span_processor_1.addIgnoredPrefix)(DEFAULT_OPENBOX_URL);
        (0, span_processor_1.setupSpanProcessorInstrumentation)({ http: this._config.instrumentHttp });
        (0, node_instrumentation_1.setupNodeHookInstrumentation)({
            fileIo: this._config.instrumentFileIo,
            databases: this._config.databases,
            logger: this._config.logger,
        });
    }
    // ── Lifecycle hooks ────────────────────────────────────────────────────────
    /**
     * before_agent() — session setup.
     * threadId replaces Python's runtime.config.configurable.thread_id.
     * Returns the minted turn identity — pass it to every subsequent call.
     */
    async beforeAgent(state, threadId) {
        return (0, hook_handlers_1.handleBeforeAgent)(this, state, threadId);
    }
    /** after_agent() — session close. Returns the WorkflowCompleted verdict. */
    async afterAgent(turn, state, failedWith) {
        return (0, hook_handlers_1.handleAfterAgent)(this, turn, state, failedWith);
    }
    /**
     * wrap_model_call() — LLM governance.
     * messages is the full array passed to model.invoke().
     * handler is the thunk that performs the actual model call.
     */
    async wrapModelCall(turn, messages, handler) {
        return (0, hook_handlers_1.handleWrapModelCall)(this, turn, messages, handler);
    }
    /**
     * wrap_tool_call() — tool governance.
     * In the Python SDK the full ToolCallRequest is passed; here we decompose
     * it so the node doesn't need to construct the LangChain request object.
     */
    async wrapToolCall(turn, toolName, toolArgs, handler) {
        return (0, tool_hook_1.handleWrapToolCall)(this, turn, toolName, toolArgs, handler);
    }
    /**
     * wrap_memory_op() — scope memory load/save inside a short-lived activity
     * so database queries inside the memory node (e.g. pg Chat Memory) generate
     * db_query spans visible on the OpenBox dashboard.
     */
    async wrapMemoryOp(turn, opType, fn) {
        return (0, hook_handlers_1.handleWrapMemoryOp)(this, turn, opType, fn);
    }
}
exports.OpenBoxLangChainMiddleware = OpenBoxLangChainMiddleware;
