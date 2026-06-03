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

import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeConnectionTypes,
  NodeOperationError,
} from 'n8n-workflow';

import {
  testOpenBoxCredential,
  testMysqlCredential,
  testMongoDbCredential,
  testPostgresCredential,
  testRedisCredential,
  testSearXngCredential,
} from '../../shared/credential-test';
import {
  GovernanceBlockedError,
  GovernanceHaltError,
  GuardrailsValidationError,
  OpenBoxLangChainMiddleware,
} from '../../shared/langchain';

// ── ToolMessage factory ───────────────────────────────────────────────────────
// @langchain/core is always present in n8n's runtime.
const LangchainToolMessage: (new (opts: {
  content: string;
  tool_call_id: string;
  name: string;
}) => unknown) | null = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@langchain/core/messages').ToolMessage;
  } catch {
    return null;
  }
})();

function makeToolMessage(content: string, tool_call_id: string, name: string): unknown {
  if (LangchainToolMessage) return new LangchainToolMessage({ content, tool_call_id, name });
  return { role: 'tool', content, tool_call_id, name };
}

/**
 * Detect error strings that n8n's ToolHttpRequest returns instead of throwing.
 *
 * Path 1 — httpRequest() throws (connection refused, DNS, etc.):
 *   "HTTP 503 There was an error: \"<message>\""
 *   "There was an error: \"<message>\""
 *
 * Path 2 — returnFullResponse=true, server returns 4xx/5xx body directly:
 *   raw HTML page whose <title> contains the HTTP error code
 *   raw JSON with a top-level "error" key or statusCode >= 400
 */
function isToolErrorResult(result: string): boolean {
  if (!result) return false;
  // n8n explicit error prefix (path 1)
  if (/^(HTTP \d{3} )?There was an error:/i.test(result.trimStart())) return true;
  // HTML error page with HTTP status code in <title> (path 2)
  if (/^\s*<(!DOCTYPE\s+html|html)/i.test(result)) {
    return /<title>[^<]*(4\d{2}|5\d{2})[^<]*<\/title>/i.test(result);
  }
  // JSON error body: { "error": ..., "statusCode": 4xx/5xx }
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (typeof parsed === 'object' && parsed !== null) {
      const code = Number(parsed.statusCode ?? parsed.status ?? parsed.code ?? 0);
      if (code >= 400) return true;
      if (parsed.error && parsed.error !== false) return true;
    }
  } catch { /* not JSON */ }
  return false;
}

function extractToolErrorMessage(result: string): string {
  // For HTML pages, pull the <title> text as a human-readable summary
  const titleMatch = /<title>([^<]+)<\/title>/i.exec(result);
  if (titleMatch) return titleMatch[1].trim();
  // For JSON bodies, pull the error/message field
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    const msg = parsed.message ?? parsed.error ?? parsed.detail;
    if (msg && typeof msg === 'string') return msg;
  } catch { /* not JSON */ }
  // Trim the raw string to a reasonable length
  return result.length > 200 ? result.slice(0, 200) + '…' : result;
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: unknown) => (c as { type?: string }).type === 'text')
      .map((c: unknown) => (c as { text?: string }).text ?? '')
      .join('');
  }
  return content == null ? '' : String(content);
}

// ── Node ──────────────────────────────────────────────────────────────────────

export class OpenBoxAgent implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'OpenBox: Agent',
    name: 'openBoxAgent',
    icon: 'file:OB_logomark.png',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["options"]["systemMessage"] ? "Custom System Prompt" : ""}}',
    description:
      'AI agent with OpenBox governance. Connect a Chat Model, Memory, and Tools as sub-nodes. Sends the same lifecycle events as the LangChain Python SDK.',
    defaults: { name: 'OpenBox: Agent' },
    inputs: [
      NodeConnectionTypes.Main,
      {
        type: NodeConnectionTypes.AiLanguageModel,
        displayName: 'Chat Model',
        required: true,
        maxConnections: 1,
      },
      {
        type: NodeConnectionTypes.AiMemory,
        displayName: 'Memory',
        required: false,
        maxConnections: 1,
      },
      {
        type: NodeConnectionTypes.AiTool,
        displayName: 'Tool',
        required: false,
      },
    ] as unknown as INodeTypeDescription['inputs'],
    outputs: [NodeConnectionTypes.Main] as unknown as INodeTypeDescription['outputs'],
    credentials: [
      { name: 'openBoxApi', required: false, testedBy: 'openBoxApiCredentialTest' },
      { name: 'postgres', required: false, testedBy: 'postgresConnectionTest' },
      { name: 'mySql', required: false, testedBy: 'mysqlConnectionTest' },
      { name: 'mongoDb', required: false, testedBy: 'mongoDbConnectionTest' },
      { name: 'redis', required: false, testedBy: 'redisConnectionTest' },
      { name: 'searXngApi', required: false, testedBy: 'searXngConnectionTest' },
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
            description:
              'Looks for chatInput, text, message, input, query, or the first string field',
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
            default:
              'You are a helpful assistant. Use the tools available to you to answer questions accurately.',
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
      openBoxApiCredentialTest: testOpenBoxCredential,
      postgresConnectionTest: testPostgresCredential,
      mysqlConnectionTest: testMysqlCredential,
      mongoDbConnectionTest: testMongoDbCredential,
      redisConnectionTest: testRedisCredential,
      searXngConnectionTest: testSearXngCredential,
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const output: INodeExecutionData[] = [];

    // ── Retrieve connected sub-nodes ─────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = (await this.getInputConnectionData(NodeConnectionTypes.AiLanguageModel, 0)) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = ((await this.getInputConnectionData(NodeConnectionTypes.AiTool, 0)) as any[]) ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const memory = ((await this.getInputConnectionData(NodeConnectionTypes.AiMemory, 0)) as any) ?? null;

    if (!model) {
      throw new NodeOperationError(
        this.getNode(),
        'No Chat Model connected. Drag a language model sub-node (e.g. "OpenAI Chat Model") into the Chat Model input.',
      );
    }

    const options = this.getNodeParameter('options', 0, {}) as {
      systemMessage?: string;
      maxIterations?: number;
    };
    const systemMessage = options.systemMessage ?? 'You are a helpful assistant.';
    const maxIterations = options.maxIterations ?? 10;
    const promptType = this.getNodeParameter('promptType', 0, 'auto') as string;
    const workflowType = `n8n.Agent.${this.getNode().name.replace(/\s+/g, '_')}`;

    // Bind tools to model once (immutable across items)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const boundModel: any = tools.length > 0 ? model.bindTools(tools) : model;

    // ── Build middleware (one instance per execute() call, reset per item) ───
    const middleware = new OpenBoxLangChainMiddleware(
      { agentName: workflowType, taskQueue: 'n8n' },
      this,
    );

    for (let i = 0; i < items.length; i++) {
      const itemJson = items[i].json as Record<string, unknown>;

      // ── Resolve session_id ─────────────────────────────────────────────────
      if (typeof itemJson.sessionId === 'string') {
        middleware._config.sessionId = itemJson.sessionId;
      }

      // ── Resolve prompt ─────────────────────────────────────────────────────
      let userMessage: string;
      if (promptType === 'define') {
        userMessage = String(this.getNodeParameter('text', i, '')).trim();
      } else {
        const CANDIDATES = ['chatInput', 'text', 'message', 'input', 'query', 'prompt'];
        const hit = CANDIDATES.find(
          (f) => typeof itemJson[f] === 'string' && (itemJson[f] as string).trim() !== '',
        );
        if (hit) {
          userMessage = (itemJson[hit] as string).trim();
        } else {
          const anyStr = Object.keys(itemJson).find(
            (k) => typeof itemJson[k] === 'string' && (itemJson[k] as string).trim() !== '',
          );
          userMessage = anyStr ? (itemJson[anyStr] as string).trim() : '';
        }
      }

      if (!userMessage) {
        throw new NodeOperationError(
          this.getNode(),
          `No prompt found on item ${i}. Connect a Chat Trigger or set Prompt to "Define Below".`,
          { itemIndex: i },
        );
      }

      // ── threadId mirrors Python SDK's configurable.thread_id ──────────────
      const execId = this.getExecutionId();
      const threadId = `${String(this.getWorkflow().id ?? 'wf')}-${execId}`;

      // messages declared here so afterAgent always has the latest state.
      const messages: unknown[] = [];
      let finalOutput = '';
      let iterations = 0;
      let toolCallCount = 0;
      // Capture any governance/runtime error from the agent loop so afterAgent
      // (WorkflowCompleted) can always fire — matching Python SDK's behaviour
      // of sending WorkflowCompleted with status "failed" before re-raising.
      let loopError: unknown = null;

      try {
        // ════════════════════════════════════════════════════════════════════
        // before_agent — SignalReceived + WorkflowStarted + pre-screen
        // ════════════════════════════════════════════════════════════════════
        await middleware.beforeAgent({ messages: [['human', userMessage]] }, threadId);

        // ── Load memory (after beforeAgent so middleware IDs are set) ────────
        let chatHistory: unknown[] = [];
        if (memory) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const vars = await middleware.wrapMemoryOp<any>('loadMemoryVariables', () =>
              memory.loadMemoryVariables({ input: userMessage }),
            );
            chatHistory = (vars.chat_history ?? vars.history ?? []) as unknown[];
          } catch { /* non-fatal */ }
        }

        messages.push(['system', systemMessage], ...chatHistory, ['human', userMessage]);

        // ════════════════════════════════════════════════════════════════════
        // Agent loop — each iteration calls wrapModelCall / wrapToolCall
        // ════════════════════════════════════════════════════════════════════
        const cancelSignal =
          typeof this.getExecutionCancelSignal === 'function'
            ? this.getExecutionCancelSignal()
            : undefined;

        agentLoop: for (let iter = 0; iter < maxIterations; iter++) {
          iterations = iter + 1;

          // ── wrapModelCall ────────────────────────────────────────────────
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let response: any;
          try {
            response = await middleware.wrapModelCall(messages, () =>
              boundModel.invoke(messages, { signal: cancelSignal }),
            );
          } catch (err) {
            loopError = err;
            break agentLoop;
          }

          const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> =
            response?.tool_calls ?? [];

          // No tool calls → final response
          if (!toolCalls.length) {
            finalOutput = extractTextContent(response?.content);
            messages.push(response);
            break agentLoop;
          }

          messages.push(response); // AIMessage with tool_calls

          // ── wrapToolCall per tool ────────────────────────────────────────
          for (const toolCall of toolCalls) {
            toolCallCount++;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const tool = tools.find((t: any) => t.name === toolCall.name);
            if (!tool) {
              loopError = new NodeOperationError(
                this.getNode(),
                `Tool "${toolCall.name}" is not connected.`,
                { itemIndex: i },
              );
              break;
            }

            let toolResult = '';
            try {
              const raw = await middleware.wrapToolCall(toolCall.name, toolCall.args, () =>
                tool.invoke(toolCall.args),
              );
              // null/undefined (e.g. HTTP node with empty/null response body) → empty string
              // so the LLM receives a ToolMessage with valid content instead of crashing.
              if (raw != null) {
                toolResult = typeof raw === 'string' ? raw : JSON.stringify(raw);
              }
            } catch (err) {
              // Governance errors abort the loop so afterAgent fires with failed status.
              if (
                err instanceof GovernanceHaltError ||
                err instanceof GovernanceBlockedError ||
                err instanceof GuardrailsValidationError
              ) {
                loopError = err;
                break;
              }
              // Non-governance tool errors (HTTP 4xx/5xx, timeout, parse failure, etc.):
              // stop the agent immediately and surface the error as the final output
              // so n8n completes the execution rather than running more LLM iterations.
              finalOutput = `Tool "${toolCall.name}" failed: ${err instanceof Error ? err.message : String(err)}`;
              break agentLoop;
            }

            // n8n's ToolHttpRequest does not throw for HTTP error responses — it
            // returns the error body as a string via two paths:
            //   1. httpRequest() throws  → "HTTP 503 There was an error: \"<msg>\""
            //   2. returnFullResponse=true catches 5xx → raw HTML/JSON body
            // Detect both and stop the agent immediately instead of feeding the
            // error body back to the LLM and looping.
            if (isToolErrorResult(toolResult)) {
              finalOutput = `Tool "${toolCall.name}" failed: ${extractToolErrorMessage(toolResult)}`;
              break agentLoop;
            }

            if (loopError != null) break;
            messages.push(makeToolMessage(toolResult, toolCall.id, toolCall.name));
          }

          if (loopError != null) break agentLoop;
        }

        if (!finalOutput && iterations >= maxIterations) {
          finalOutput = `[Agent reached max iterations (${maxIterations}) without a final response.]`;
        }

        // ── Save to memory (before afterAgent so memory_save events land inside
        // the open workflow on Core's execution tree, not after WorkflowCompleted
        // has already closed it). Only save on success — loopError is still null here
        // because any break-with-error also sets loopError before reaching this point.
        if (memory && loopError == null) {
          try {
            await middleware.wrapMemoryOp('saveContext', () =>
              memory.saveContext({ input: userMessage }, { output: finalOutput }),
            );
          } catch { /* non-fatal */ }
        }
      } catch (err) {
        loopError = err;
      }

      // ══════════════════════════════════════════════════════════════════════
      // after_agent — WorkflowCompleted (always fires; failed status on error)
      // ══════════════════════════════════════════════════════════════════════
      let completedVerdict;
      try {
        completedVerdict = await middleware.afterAgent(
          { messages },
          loopError instanceof Error ? loopError : loopError != null ? new Error(String(loopError)) : undefined,
        );
      } catch (err) {
        if (loopError == null) {
          mapGovernanceError(err, this, i);
          throw err;
        }
        // non-fatal when we already have a loopError
      }

      // Re-throw loop error AFTER afterAgent has fired
      if (loopError != null) {
        mapGovernanceError(loopError, this, i);
        throw loopError as Error;
      }

      // Apply output redaction from WorkflowCompleted guardrails to the node's
      // OUTPUT only — memory already stores the true agent response above.
      const gr =
        completedVerdict?.guardrails_result ??
        (completedVerdict as Record<string, unknown> | null | undefined)?.guardrailsResult as
          | Record<string, unknown>
          | undefined;
      if (gr?.redacted_input && gr.input_type === 'activity_output') {
        finalOutput = String(gr.redacted_input);
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

// ── Governance error → NodeOperationError ─────────────────────────────────────

function mapGovernanceError(
  err: unknown,
  ctx: IExecuteFunctions,
  itemIndex: number,
): void {
  if (err instanceof GovernanceHaltError) {
    throw new NodeOperationError(ctx.getNode(), err.message, { itemIndex });
  }
  if (err instanceof GovernanceBlockedError) {
    throw new NodeOperationError(
      ctx.getNode(),
      `OpenBox governance requires approval`,
      { itemIndex, description: err.message },
    );
  }
  if (err instanceof GuardrailsValidationError) {
    throw new NodeOperationError(
      ctx.getNode(),
      `OpenBox guardrails validation failed: ${err.message}`,
      { itemIndex },
    );
  }
}
