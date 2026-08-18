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
 *
 * Optional fallback model (`needsFallback`) and streaming (`options.
 * enableStreaming`) mirror the shape of n8n's own official
 * @n8n/nodes-langchain Agent node (same parameter names, same dynamic
 * `inputs` mechanism, same `begin`/`item`/`end` sendChunk protocol — see
 * that package's `nodes/agents/Agent/utils.ts` and `utils/agent-execution/
 * processEventStream.ts`), so workflows already wired for the official
 * agent need minimal changes to repoint at this one. Streaming here is
 * DELIBERATELY not real per-token generation: the model call and full
 * governance/redaction pipeline run exactly as in the non-streaming path,
 * and only the finished, already-redacted text is chunked out afterward —
 * real incremental token streaming would let unredacted output reach the
 * caller before any output-side guardrail (PII wall, toxicity filter) has
 * a chance to block or redact it.
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

// ── Toolkit flattening ───────────────────────────────────────────────────────
/**
 * Flatten whatever the ai_tool port hands back into a flat list of callable
 * tools.
 *
 * `getInputConnectionData(AiTool)` does NOT always return plain tools: nodes
 * like `@n8n/n8n-nodes-langchain.mcpClientTool` (Composio, and any other MCP
 * server) supply a LangChain *Toolkit* — one connection object exposing many
 * tools behind `getTools()` / `.tools`. n8n's own official Agent node goes
 * through `getConnectedTools()`, which unwraps those; reading the port raw
 * (as we did) leaves the toolkit as a single opaque object with no `.name`,
 * so every tool inside it is invisible to the model.
 *
 * Handles, recursively: plain tools, arrays, `getTools()` toolkits, and
 * `.tools` array properties. Anything unrecognised is dropped rather than
 * passed through, so a non-tool can never reach `model.bindTools()`.
 */
export function flattenConnectedTools(raw: unknown): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown, depth: number): void => {
    // Depth cap guards against a toolkit that (directly or via a cycle)
    // reports itself as one of its own tools.
    if (node == null || depth > 5) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    const candidate = node as { name?: unknown; invoke?: unknown; getTools?: unknown; tools?: unknown };

    // A real tool: has a string name and an invoke(). Checked FIRST — some
    // toolkits also expose a `tools` property, but a thing that is itself
    // directly callable is a tool, not a container.
    if (typeof candidate.name === 'string' && typeof candidate.invoke === 'function') {
      out.push(node);
      return;
    }
    // Toolkit: getTools() returns the real tools.
    if (typeof candidate.getTools === 'function') {
      try {
        visit((candidate.getTools as () => unknown)(), depth + 1);
      } catch { /* a toolkit that fails to enumerate contributes nothing */ }
      return;
    }
    // Toolkit variant exposing a plain `tools` array.
    if (Array.isArray(candidate.tools)) visit(candidate.tools, depth + 1);
  };

  visit(raw, 0);

  // Deduplicate by tool name — the model addresses tools by name, so two
  // tools sharing one name make dispatch ambiguous. First wins, matching
  // n8n's own precedence.
  const byName = new Map<string, unknown>();
  for (const tool of out) {
    const name = (tool as { name: string }).name;
    if (!byName.has(name)) byName.set(name, tool);
  }
  return [...byName.values()];
}

// ── Session ID resolution ────────────────────────────────────────────────────
/**
 * Find the caller's session id on the incoming item so governance events
 * correlate across turns.
 *
 * Real webhook payloads rarely put a camelCase `sessionId` at the top level —
 * n8n's Webhook node nests the posted JSON under `body`, and callers commonly
 * use snake_case. Checking only `json.sessionId` (as we did) meant every turn
 * of a real conversation opened a NEW OpenBox session, so traces never joined
 * up with the chat memory, which keys off the same field.
 *
 * Checks top level first, then one level into `body`, camelCase before
 * snake_case at each level.
 */
export function resolveSessionId(itemJson: Record<string, unknown>): string | undefined {
  const KEYS = ['sessionId', 'session_id'];
  const pick = (source: unknown): string | undefined => {
    if (source == null || typeof source !== 'object') return undefined;
    const record = source as Record<string, unknown>;
    for (const key of KEYS) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
      // Numeric session ids are common from SQL-backed callers.
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return undefined;
  };
  return pick(itemJson) ?? pick(itemJson.body);
}

// ── Intermediate steps ───────────────────────────────────────────────────────
/**
 * One agent tool call, in the shape n8n's official Agent node emits under
 * `returnIntermediateSteps` — downstream Code nodes and tool loggers read
 * `step.action.tool` / `step.action.toolInput` / `step.observation`.
 */
export interface IntermediateStep {
  action: { tool: string; toolInput: Record<string, unknown>; log: string; toolCallId?: string };
  observation: string;
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

// ── Dynamic inputs (fallback model) ──────────────────────────────────────────
// Embedded into the `inputs` ExpressionString below via `.toString()` — n8n
// evaluates `inputs` server-side with only `$parameter` in scope, so this
// function is re-parsed from its serialized source rather than called
// directly here, and must be fully self-contained (no closures over outer
// variables, no imported symbols — string literals only, matching the "Note
// cannot use NodeConnectionType.Main" caveat in n8n's own equivalent
// getInputs() helper). Same connection shape as the official Agent node's
// Chat Model port; a second identical port ("Fallback Model") only appears
// when needsFallback is true, so existing single-model workflows using this
// node see byte-identical input ports.
export function getOpenBoxAgentInputs(needsFallback: boolean): unknown[] {
  const languageModelFilter = {
    excludedNodes: [
      '@n8n/n8n-nodes-langchain.lmCohere',
      '@n8n/n8n-nodes-langchain.lmOllama',
      '@n8n/n8n-nodes-langchain.lmOpenHuggingFaceInference',
    ],
  };
  const inputs: unknown[] = [
    { type: 'main' },
    {
      type: 'ai_languageModel',
      displayName: 'Chat Model',
      required: true,
      maxConnections: 1,
      filter: languageModelFilter,
    },
  ];
  if (needsFallback) {
    inputs.push({
      type: 'ai_languageModel',
      displayName: 'Fallback Model',
      required: true,
      maxConnections: 1,
      filter: languageModelFilter,
    });
  }
  inputs.push(
    { type: 'ai_memory', displayName: 'Memory', required: false, maxConnections: 1 },
    { type: 'ai_tool', displayName: 'Tool', required: false },
  );
  return inputs;
}

// ── Streaming ─────────────────────────────────────────────────────────────────
/**
 * Emits an already-fully-governed/redacted string as n8n stream chunks —
 * same `begin` → `item`(s) → `end` protocol n8n's own official Agent node
 * uses (see @n8n/nodes-langchain's processEventStream.ts), just fed from one
 * finished, already-redacted string instead of live per-token LLM events.
 * `Pick<...>` keeps this trivially unit-testable with a bare `{ sendChunk }`.
 */
export function emitStreamChunks(
  ctx: Pick<IExecuteFunctions, 'sendChunk'>,
  itemIndex: number,
  text: string,
  chunkSize = 40,
): void {
  ctx.sendChunk('begin', itemIndex);
  for (let start = 0; start < text.length; start += chunkSize) {
    ctx.sendChunk('item', itemIndex, text.slice(start, start + chunkSize));
  }
  ctx.sendChunk('end', itemIndex);
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
    inputs: `={{
      ((needsFallback) => {
        ${getOpenBoxAgentInputs.toString()};
        return getOpenBoxAgentInputs(needsFallback);
      })($parameter.needsFallback === true)
    }}` as unknown as INodeTypeDescription['inputs'],
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
      // ── Fallback model ──────────────────────────────────────────────────────
      // Same parameter name/shape as the official Agent node's own
      // needsFallback toggle — every model call still goes through
      // wrapModelCall (its own LLMStarted/LLMCompleted governance events),
      // whichever model actually ran it.
      {
        displayName: 'Enable Fallback Model',
        name: 'needsFallback',
        type: 'boolean',
        default: false,
        noDataExpression: true,
      },
      {
        displayName:
          'Connect an additional language model on the canvas to use it as a fallback if the main model call fails',
        name: 'fallbackNotice',
        type: 'notice',
        default: '',
        displayOptions: { show: { needsFallback: [true] } },
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
            displayName: 'Automatically Passthrough Binary Images',
            name: 'passthroughBinaryImages',
            type: 'boolean',
            default: true,
            description:
              'Whether or not binary images should be automatically passed through to the agent as image type messages',
          },
          {
            displayName: 'Enable Streaming',
            name: 'enableStreaming',
            type: 'boolean',
            default: false,
            description:
              'Whether to deliver the final response as streamed chunks instead of a single output item. Requires the connected trigger/webhook to also use a streaming response mode. Not real per-token generation: the model call and all governance/redaction run exactly as in the non-streaming path first, and only the finished, already-redacted text is then chunked out — output guardrails are never bypassed.',
          },
          {
            displayName: 'Max Iterations',
            name: 'maxIterations',
            type: 'number',
            default: 10,
            description: 'The maximum number of iterations the agent will run before stopping',
          },
          {
            displayName: 'On Tool Error',
            name: 'onToolError',
            type: 'options',
            options: [
              { name: 'Return the Error to the Model (Let It Recover)', value: 'returnToModel' },
              { name: 'Stop the Agent and Return the Error', value: 'stopAgent' },
            ],
            default: 'returnToModel',
            description:
              'What to do when a connected tool fails. "Return the error to the model" matches n8n\'s official Agent node: the failure is fed back as a tool result so the agent can retry or route around it — required by tools deliberately configured with Never Error/Full Response. Governance halts and blocks always stop the agent regardless of this setting.',
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
            displayName: 'System Message',
            name: 'systemMessage',
            type: 'string',
            typeOptions: { rows: 6 },
            default: 'You are a helpful assistant',
            description: 'The message that will be sent to the agent before the conversation starts',
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
    const model = (await this.getInputConnectionData(NodeConnectionTypes.AiLanguageModel, 0, 0)) as any;
    // Flattened, because an ai_tool connection may be a Toolkit supplying many
    // tools (MCP / Composio) rather than a single tool — see
    // flattenConnectedTools above.
    const rawToolConnection = await this.getInputConnectionData(NodeConnectionTypes.AiTool, 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = flattenConnectedTools(rawToolConnection) as any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const memory = ((await this.getInputConnectionData(NodeConnectionTypes.AiMemory, 0)) as any) ?? null;

    if (!model) {
      throw new NodeOperationError(
        this.getNode(),
        'No Chat Model connected. Drag a language model sub-node (e.g. "OpenAI Chat Model") into the Chat Model input.',
      );
    }

    // needsFallback drives the second AiLanguageModel port added by
    // getOpenBoxAgentInputs above — inputIndex 1, matching n8n's own
    // official Agent node convention.
    const needsFallback = this.getNodeParameter('needsFallback', 0, false) as boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fallbackModel: any = null;
    if (needsFallback) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fallbackModel = (await this.getInputConnectionData(NodeConnectionTypes.AiLanguageModel, 0, 1)) as any;
      if (!fallbackModel) {
        throw new NodeOperationError(
          this.getNode(),
          'Please connect a model to the Fallback Model input or disable the fallback option.',
        );
      }
    }

    const options = this.getNodeParameter('options', 0, {}) as {
      systemMessage?: string;
      maxIterations?: number;
      returnIntermediateSteps?: boolean;
      passthroughBinaryImages?: boolean;
      enableStreaming?: boolean;
      onToolError?: 'returnToModel' | 'stopAgent';
    };
    const systemMessage = options.systemMessage ?? 'You are a helpful assistant';
    const maxIterations = options.maxIterations ?? 10;
    const returnIntermediateSteps = options.returnIntermediateSteps ?? false;
    // Default matches n8n's official Agent node: a failing tool is reported
    // back to the model rather than ending the run.
    const onToolError = options.onToolError ?? 'returnToModel';
    // isStreaming() reflects whether the actual webhook/trigger is running in
    // streaming response mode this execution — enableStreaming is this node's
    // own opt-in on top of that, matching the official Agent node's gating.
    // typeof-guarded since this API may not exist on older installed n8n.
    const streamingRequested =
      (options.enableStreaming ?? false) &&
      typeof this.isStreaming === 'function' &&
      this.isStreaming() &&
      typeof this.sendChunk === 'function';
    const promptType = this.getNodeParameter('promptType', 0, 'auto') as string;
    const workflowType = `n8n.Agent.${this.getNode().name.replace(/\s+/g, '_')}`;

    // Bind tools to model(s) once (immutable across items)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const boundModel: any = tools.length > 0 ? model.bindTools(tools) : model;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const boundFallbackModel: any = fallbackModel
      ? tools.length > 0
        ? fallbackModel.bindTools(tools)
        : fallbackModel
      : null;

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
      const sessionId = resolveSessionId(itemJson);
      if (sessionId) {
        middleware._config.sessionId = sessionId;
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
      // Every tool call this item made, in the official Agent node's shape.
      // Always collected (the cost is negligible and it keeps the loop simple);
      // only surfaced on the output item when returnIntermediateSteps is on.
      const intermediateSteps: IntermediateStep[] = [];
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

          // ── wrapModelCall (with fallback retry) ──────────────────────────
          // A failed primary call retries once against the fallback model,
          // when connected — as its own wrapModelCall, so it gets its own
          // LLMStarted/LLMCompleted governance events exactly like the
          // primary attempt. Includes governance halts/blocks from the
          // primary attempt, not just transport errors: retrying re-submits
          // the same prompt through the full governance pipeline again on
          // the fallback model, it does not bypass it.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let response: any;
          try {
            response = await middleware.wrapModelCall(turn, messages, () =>
              boundModel.invoke(messages, { signal: cancelSignal }),
            );
          } catch (primaryErr) {
            if (!boundFallbackModel) {
              loopError = primaryErr;
              break agentLoop;
            }
            try {
              response = await middleware.wrapModelCall(turn, messages, () =>
                boundFallbackModel.invoke(messages, { signal: cancelSignal }),
              );
            } catch (fallbackErr) {
              loopError = fallbackErr;
              break agentLoop;
            }
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

            // Records the step and either feeds the failure back to the model
            // (official Agent node behaviour, the default) or ends the run.
            // Returns true when the caller should stop the agent loop.
            const handleToolFailure = (message: string): boolean => {
              const observation = `Error: ${message}`;
              intermediateSteps.push({
                action: {
                  tool: toolCall.name,
                  toolInput: toolCall.args ?? {},
                  log: `Invoking "${toolCall.name}"`,
                  toolCallId: toolCall.id,
                },
                observation,
              });
              if (onToolError === 'stopAgent') {
                finalOutput = `Tool "${toolCall.name}" failed: ${message}`;
                return true;
              }
              // The model needs a ToolMessage for EVERY tool_call id it issued,
              // or the next request is malformed — so the error goes back as the
              // tool's result and the agent gets a chance to recover.
              messages.push(makeToolMessage(observation, toolCall.id, toolCall.name));
              return false;
            };

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const tool = tools.find((t: any) => t.name === toolCall.name);
            if (!tool) {
              if (handleToolFailure(`Tool "${toolCall.name}" is not connected.`)) break agentLoop;
              continue;
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
              // Governance errors always abort the loop, whatever onToolError
              // says — a blocked or halted call must never be retried or
              // reported to the model as a recoverable tool failure.
              if (
                err instanceof GovernanceHaltError ||
                err instanceof GovernanceBlockedError ||
                err instanceof GuardrailsValidationError
              ) {
                loopError = err;
                break;
              }
              // Non-governance tool errors (HTTP 4xx/5xx, timeout, parse failure, etc.)
              if (handleToolFailure(err instanceof Error ? err.message : String(err))) {
                break agentLoop;
              }
              continue;
            }

            // n8n's ToolHttpRequest does not throw for HTTP error responses — it
            // returns the error body as a string via two paths:
            //   1. httpRequest() throws  → "HTTP 503 There was an error: \"<msg>\""
            //   2. returnFullResponse=true catches 5xx → raw HTML/JSON body
            // Detect both and treat them as a tool failure rather than a result.
            if (isToolErrorResult(toolResult)) {
              if (handleToolFailure(extractToolErrorMessage(toolResult))) break agentLoop;
              continue;
            }

            if (loopError != null) break;
            intermediateSteps.push({
              action: {
                tool: toolCall.name,
                toolInput: toolCall.args ?? {},
                log: `Invoking "${toolCall.name}"`,
                toolCallId: toolCall.id,
              },
              observation: toolResult,
            });
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

      // Chunk-emit only AFTER finalOutput is fully governed/redacted above —
      // never the raw model output, and never before guardrails have had a
      // chance to block/redact it.
      if (streamingRequested) {
        emitStreamChunks(this, i, finalOutput);
      }

      output.push({
        json: {
          ...itemJson,
          output: finalOutput,
          // Same key and shape the official Agent node uses, so downstream
          // Code nodes / tool loggers reading `intermediateSteps` keep working
          // when this node replaces it.
          ...(returnIntermediateSteps ? { intermediateSteps } : {}),
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
