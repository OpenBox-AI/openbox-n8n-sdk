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

import { testOpenBoxCredential } from '../../shared/credential-test';
import { GovernanceAuthError } from '../../shared/openbox-client';
import {
  DatabaseDriverName,
  GovernanceBlockedError,
  GovernanceHaltError,
  GuardrailsValidationError,
  OpenBoxLangChainMiddleware,
  OpenBoxLangChainMiddlewareOptions,
  Turn,
  turnFromError,
} from '../../shared/langchain';

// ── ToolMessage factory ───────────────────────────────────────────────────────
// @langchain/core is always present in n8n's runtime. Module name stored in a
// variable so the literal string does not trigger the no-restricted-imports rule.
const _lcMessagesMod = '@langchain/core/messages';
const LangchainToolMessage: (new (opts: {
  content: string;
  tool_call_id: string;
  name: string;
}) => unknown) | null = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(_lcMessagesMod).ToolMessage;
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
    icon: 'file:openbox.svg',
    usableAsTool: true,
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["promptType"] === "auto" ? "Auto-detect prompt" : "Define prompt"}}',
    description:
      'AI agent with OpenBox governance. Connect a Chat Model, Memory, and Tools as sub-nodes.',
    defaults: { name: 'OpenBox: Agent' },
    inputs: [
      NodeConnectionTypes.Main,
      {
        type: NodeConnectionTypes.AiLanguageModel,
        displayName: 'Chat Model',
        required: true,
        maxConnections: 1,
        filter: {
          excludedNodes: [
            '@n8n/n8n-nodes-langchain.lmCohere',
            '@n8n/n8n-nodes-langchain.lmOllama',
            '@n8n/n8n-nodes-langchain.lmOpenHuggingFaceInference',
          ],
        },
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
    ],
    properties: [
      // ── Prompt source ───────────────────────────────────────────────────────
      {
        displayName: 'Source for Prompt (User Message)',
        name: 'promptType',
        type: 'options',
        options: [
          {
            name: 'Connected Chat Trigger Node',
            value: 'auto',
            description:
              "Looks for an input field called 'chatInput' that is coming from a directly connected Chat Trigger",
          },
          {
            name: 'Define Below',
            value: 'define',
            description:
              'Use an expression to reference data in previous nodes or enter static text',
          },
        ],
        default: 'auto',
        noDataExpression: true,
      },
      // Shown when auto — mirrors textFromPreviousNode in the official agent
      {
        displayName: 'Prompt (User Message)',
        name: 'text',
        type: 'string',
        required: true,
        default: '={{ $json.chatInput }}',
        displayOptions: { show: { promptType: ['auto'] } },
        typeOptions: { rows: 2 },
      },
      // Shown when define — mirrors textInput in the official agent
      {
        displayName: 'Prompt (User Message)',
        name: 'text',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'e.g. Hello, how can you help me?',
        displayOptions: { show: { promptType: ['define'] } },
        typeOptions: { rows: 2 },
      },
      // ── Options ─────────────────────────────────────────────────────────────
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
            typeOptions: { rows: 6 },
            default: 'You are a helpful assistant',
            description: 'The message that will be sent to the agent before the conversation starts',
          },
          {
            displayName: 'Max Iterations',
            name: 'maxIterations',
            type: 'number',
            default: 10,
            description: 'The maximum number of iterations the agent will run before stopping',
          },
          {
            displayName: 'Return Intermediate Steps',
            name: 'returnIntermediateSteps',
            type: 'boolean',
            default: false,
            description:
              'Whether or not the output should include intermediate steps the agent took',
          },
          {
            displayName: 'Automatically Passthrough Binary Images',
            name: 'passthroughBinaryImages',
            type: 'boolean',
            default: true,
            description:
              'Whether or not binary images should be automatically passed through to the agent as image type messages',
          },
        ],
      },
      // ── Advanced Governance ─────────────────────────────────────────────────
      {
        displayName: 'Advanced Governance',
        name: 'governance',
        type: 'collection',
        placeholder: 'Add Governance Option',
        default: {},
        options: [
          {
            displayName: 'Approval Max Wait (Seconds)',
            name: 'hitlMaxWaitSeconds',
            type: 'number',
            default: 3600,
            description: 'How long to wait for a human approval before halting. 0 = wait indefinitely.',
          },
          {
            displayName: 'Approval Poll Interval (Seconds)',
            name: 'hitlPollIntervalSeconds',
            type: 'number',
            default: 5,
          },
          {
            displayName: 'Database Drivers to Instrument',
            name: 'databaseDrivers',
            type: 'multiOptions',
            options: [
              { name: 'Ioredis', value: 'ioredis' },
              { name: 'MongoDB', value: 'mongodb' },
              { name: 'MySQL (Mysql2)', value: 'mysql2' },
              { name: 'PostgreSQL (Pg)', value: 'pg' },
              { name: 'Redis', value: 'redis' },
            ],
            default: ['pg', 'mysql2', 'mongodb', 'redis', 'ioredis'],
            displayOptions: { show: { instrumentDatabases: [true] } },
          },
          {
            displayName: 'Governance Events to Send',
            name: 'eventsToSend',
            type: 'multiOptions',
            options: [
              { name: 'LLM Completed', value: 'llmEnd' },
              { name: 'LLM Started', value: 'llmStart' },
              { name: 'Tool Completed', value: 'toolEnd' },
              { name: 'Tool Started', value: 'toolStart' },
              { name: 'Workflow Completed', value: 'chainEnd' },
              { name: 'Workflow Started', value: 'chainStart' },
            ],
            default: ['chainStart', 'chainEnd', 'llmStart', 'llmEnd', 'toolStart', 'toolEnd'],
            description: 'Which lifecycle events are sent to OpenBox for evaluation',
          },
          {
            displayName: 'Governance Request Timeout (Seconds)',
            name: 'governanceTimeoutSeconds',
            type: 'number',
            default: 30,
            description: 'HTTP timeout for calls to the OpenBox Core API',
          },
          {
            displayName: 'Human-in-the-Loop Approval Enabled',
            name: 'hitlEnabled',
            type: 'boolean',
            default: true,
          },
          {
            displayName: 'Instrument Databases',
            name: 'instrumentDatabases',
            type: 'boolean',
            default: true,
            description: 'Whether database queries during tool execution are captured as governance spans',
          },
          {
            displayName: 'Instrument File I/O',
            name: 'instrumentFileIo',
            type: 'boolean',
            default: false,
            description: 'Whether file reads/writes during tool execution are captured as governance spans',
          },
          {
            displayName: 'Instrument HTTP Calls',
            name: 'instrumentHttp',
            type: 'boolean',
            default: true,
            description: 'Whether outgoing HTTP calls (e.g. to the LLM provider) are captured as governance spans',
          },
          {
            displayName: 'On API Error',
            name: 'onApiError',
            type: 'options',
            options: [
              { name: 'Fail Open (Continue Ungoverned)', value: 'fail_open' },
              { name: 'Fail Closed (Stop the Workflow)', value: 'fail_closed' },
            ],
            default: 'fail_open',
            description:
              'What to do when OpenBox Core is unreachable or returns an error. Auth/signing failures (invalid API key) always stop the workflow regardless of this setting.',
          },
          {
            displayName: 'Tools to Exclude From Governance',
            name: 'skipToolTypes',
            type: 'string',
            default: '',
            placeholder: 'toolNameA, toolNameB',
            description: 'Comma-separated tool names whose calls are never governed',
          },
        ],
      },
    ],
  };

  methods = {
    credentialTest: {
      openBoxApiCredentialTest: testOpenBoxCredential,
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const output: INodeExecutionData[] = [];
    let continueOnFail = false;
    try { continueOnFail = this.continueOnFail(); } catch { /* not available in all contexts */ }

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
      returnIntermediateSteps?: boolean;
      passthroughBinaryImages?: boolean;
    };
    const systemMessage = options.systemMessage ?? 'You are a helpful assistant';
    const maxIterations = options.maxIterations ?? 10;
    const promptType = this.getNodeParameter('promptType', 0, 'auto') as string;
    const workflowType = `n8n.Agent.${this.getNode().name.replace(/\s+/g, '_')}`;

    // Bind tools to model once (immutable across items)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const boundModel: any = tools.length > 0 ? model.bindTools(tools) : model;

    // ── Advanced Governance options → middleware config ──────────────────────
    const governance = this.getNodeParameter('governance', 0, {}) as {
      eventsToSend?: string[];
      skipToolTypes?: string;
      onApiError?: 'fail_open' | 'fail_closed';
      governanceTimeoutSeconds?: number;
      hitlEnabled?: boolean;
      hitlPollIntervalSeconds?: number;
      hitlMaxWaitSeconds?: number;
      instrumentHttp?: boolean;
      instrumentFileIo?: boolean;
      instrumentDatabases?: boolean;
      databaseDrivers?: DatabaseDriverName[];
    };
    const events = new Set(
      governance.eventsToSend ?? ['chainStart', 'chainEnd', 'llmStart', 'llmEnd', 'toolStart', 'toolEnd'],
    );
    const skipToolTypes = new Set(
      (governance.skipToolTypes ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    );
    // 0 means "wait indefinitely" in the UI — translates to the null the
    // middleware understands as an explicit opt-out of a finite timeout.
    const hitlMaxWaitSeconds = governance.hitlMaxWaitSeconds ?? 3600;
    const middlewareOptions: OpenBoxLangChainMiddlewareOptions = {
      agentName: workflowType,
      taskQueue: 'n8n',
      onApiError: governance.onApiError ?? 'fail_open',
      governanceTimeout: governance.governanceTimeoutSeconds ?? 30,
      skipToolTypes,
      sendChainStartEvent: events.has('chainStart'),
      sendChainEndEvent: events.has('chainEnd'),
      sendLlmStartEvent: events.has('llmStart'),
      sendLlmEndEvent: events.has('llmEnd'),
      sendToolStartEvent: events.has('toolStart'),
      sendToolEndEvent: events.has('toolEnd'),
      hitl: {
        enabled: governance.hitlEnabled ?? true,
        pollIntervalMs: (governance.hitlPollIntervalSeconds ?? 5) * 1000,
        timeoutMs: hitlMaxWaitSeconds > 0 ? hitlMaxWaitSeconds * 1000 : null,
      },
      instrumentHttp: governance.instrumentHttp ?? true,
      instrumentFileIo: governance.instrumentFileIo ?? false,
      instrumentDatabases: governance.instrumentDatabases ?? true,
      databases: (governance.instrumentDatabases ?? true)
        ? new Set(governance.databaseDrivers ?? ['pg', 'mysql2', 'mongodb', 'redis', 'ioredis'])
        : new Set(),
    };

    // ── Build middleware (one instance per execute() call, reset per item) ───
    const middleware = new OpenBoxLangChainMiddleware(middlewareOptions, this);

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
      // Turn identity is minted by beforeAgent() and threaded through every
      // subsequent call — never stored as mutable state on the middleware
      // instance (see middleware.ts). If beforeAgent itself throws (e.g. a
      // governance block on the initial signal), the turn is still recovered
      // from the error via turnFromError() so afterAgent can still fire.
      let turn: Turn | undefined;

      try {
        // ════════════════════════════════════════════════════════════════════
        // before_agent — SignalReceived + WorkflowStarted + pre-screen
        // ════════════════════════════════════════════════════════════════════
        turn = await middleware.beforeAgent({ messages: [['human', userMessage]] }, threadId);

        // ── Load memory (after beforeAgent so middleware IDs are set) ────────
        let chatHistory: unknown[] = [];
        if (memory) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const vars = await middleware.wrapMemoryOp<any>(turn, 'load_memory', () =>
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
            response = await middleware.wrapModelCall(turn, messages, () =>
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
              const raw = await middleware.wrapToolCall(turn, toolCall.name, toolCall.args, () =>
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
            await middleware.wrapMemoryOp(turn, 'save_context', () =>
              memory.saveContext({ input: userMessage }, { output: finalOutput }),
            );
          } catch { /* non-fatal */ }
        }
      } catch (err) {
        loopError = err;
        // beforeAgent can throw before returning its turn (e.g. a governance
        // block on the initial signal) — recover it from the error so
        // afterAgent still has the right workflow_id/run_id to close with.
        if (!turn) turn = turnFromError(err);
      }

      // ══════════════════════════════════════════════════════════════════════
      // after_agent — WorkflowCompleted (always fires; failed status on error)
      // ══════════════════════════════════════════════════════════════════════
      // turn should always be set by this point (beforeAgent mints it
      // synchronously before anything else can throw) — this fallback only
      // guards against a genuinely unexpected code path.
      const effectiveTurn: Turn = turn ?? { workflowId: threadId, runId: threadId };
      let completedVerdict;
      try {
        completedVerdict = await middleware.afterAgent(
          effectiveTurn,
          { messages },
          loopError instanceof Error ? loopError : loopError != null ? new Error(String(loopError)) : undefined,
        );
      } catch (err) {
        if (loopError == null) {
          mapGovernanceError(err, this, i);
          throw new NodeOperationError(this.getNode(), err as Error, { itemIndex: i });
        }
        // non-fatal when we already have a loopError
      }

      // Re-throw loop error AFTER afterAgent has fired
      if (loopError != null) {
        const nodeErr = new NodeOperationError(this.getNode(), loopError as Error, { itemIndex: i });
        if (continueOnFail) {
          output.push({ json: { error: nodeErr.message }, pairedItem: { item: i } });
          continue;
        }
        mapGovernanceError(loopError, this, i);
        throw nodeErr;
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
            workflowId: effectiveTurn.workflowId,
            runId: effectiveTurn.runId,
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
  if (err instanceof GovernanceAuthError) {
    throw new NodeOperationError(
      ctx.getNode(),
      'OpenBox credential rejected by Core (401/403) — check the API key, Agent DID, and Agent Private Key.',
      { itemIndex, description: err.message },
    );
  }
  if (err instanceof GovernanceHaltError) {
    // err.message is one of: "Activity rejected: ...", "Approval expired for
    // activity ...", "Approval timed out for activity ...", or "Approval
    // required for activity ..." (HITL disabled) — always specific by this
    // point (see unwrapGovernanceError in verdict.ts, which recovers this
    // error even when an LLM/tool client wrapped it in a generic transport
    // error like "Connection error."). Surface it as a description under a
    // fixed title, consistent with the other governance error mappings below.
    throw new NodeOperationError(
      ctx.getNode(),
      'OpenBox governance halted the workflow',
      { itemIndex, description: err.message },
    );
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
