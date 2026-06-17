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

import { IExecuteFunctions } from 'n8n-workflow';

import { GovernanceClient } from './client';
import { GovernanceConfig, OpenBoxLangChainMiddlewareOptions, mergeConfig } from './config';
import { AgentState, handleAfterAgent, handleBeforeAgent, handleWrapMemoryOp, handleWrapModelCall } from './hook_handlers';
import { addIgnoredPrefix, setupSpanProcessorInstrumentation } from './span_processor';
import { setupNodeHookInstrumentation } from './node_instrumentation';
import { handleWrapToolCall } from './tool_hook';
import { GovernanceVerdictResponse } from './types';

export class OpenBoxLangChainMiddleware {
  // Per-invocation state — reset by beforeAgent() on every call
  _workflowId: string = '';
  _runId: string = '';
  _workflowType: string;

  readonly _config: GovernanceConfig;
  readonly _client: GovernanceClient;

  constructor(
    options: OpenBoxLangChainMiddlewareOptions,
    executeFunctions: IExecuteFunctions,
  ) {
    this._config = mergeConfig(options);
    this._workflowType = options.agentName ?? 'LangChainRun';
    this._client = new GovernanceClient(executeFunctions, '');

    // Ensure fetch/http spans to the OpenBox API itself are never captured
    // to avoid infinite loops (mirrors `ignored_urls` in Python SDK setup).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apiUrl = (((global as any).process?.env?.OPENBOX_API_URL as string | undefined) ?? 'https://core.openbox.ai').replace(/\/+$/, '');
    addIgnoredPrefix(apiUrl);
    setupSpanProcessorInstrumentation({ http: this._config.instrumentHttp });

    setupNodeHookInstrumentation({
      fileIo: this._config.instrumentFileIo,
      databases: this._config.instrumentDatabases,
    });
  }

  // ── Lifecycle hooks ────────────────────────────────────────────────────────

  /**
   * before_agent() — session setup.
   * threadId replaces Python's runtime.config.configurable.thread_id.
   */
  async beforeAgent(state: AgentState, threadId?: string): Promise<void> {
    return handleBeforeAgent(this, state, threadId);
  }

  /** after_agent() — session close. Returns the WorkflowCompleted verdict. */
  async afterAgent(state: AgentState, failedWith?: Error): Promise<GovernanceVerdictResponse | null> {
    return handleAfterAgent(this, state, failedWith);
  }

  /**
   * wrap_model_call() — LLM governance.
   * messages is the full array passed to model.invoke().
   * handler is the thunk that performs the actual model call.
   */
  async wrapModelCall(
    messages: unknown[],
    handler: () => Promise<unknown>,
  ): Promise<unknown> {
    return handleWrapModelCall(this, messages, handler);
  }

  /**
   * wrap_tool_call() — tool governance.
   * In the Python SDK the full ToolCallRequest is passed; here we decompose
   * it so the node doesn't need to construct the LangChain request object.
   */
  async wrapToolCall(
    toolName: string,
    toolArgs: unknown,
    handler: () => Promise<unknown>,
  ): Promise<unknown> {
    return handleWrapToolCall(this, toolName, toolArgs, handler);
  }

  /**
   * wrap_memory_op() — scope memory load/save inside a short-lived activity
   * so database queries inside the memory node (e.g. pg Chat Memory) generate
   * db_query spans visible on the OpenBox dashboard.
   */
  async wrapMemoryOp<T>(opType: 'loadMemoryVariables' | 'saveContext', fn: () => Promise<T>): Promise<T> {
    return handleWrapMemoryOp(this, opType, fn);
  }
}
