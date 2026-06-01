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
import {
  GovernanceBlockedError,
  GovernanceHaltError,
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

      // ══════════════════════════════════════════════════════════════════════
      // before_agent — SignalReceived + WorkflowStarted + pre-screen
      // Pre-screens on the raw user message only; chat history is added below.
      // ══════════════════════════════════════════════════════════════════════
      try {
        await middleware.beforeAgent({ messages: [['human', userMessage]] }, threadId);
      } catch (err) {
        mapGovernanceError(err, this, i);
        throw err;
      }

      // ── Load memory (after beforeAgent so middleware IDs are set) ──────────
      // Wrapped in wrapMemoryOp so pg queries inside the memory node are
      // captured as db_query spans under a memory_load activity.
      let chatHistory: unknown[] = [];
      if (memory) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const vars = await middleware.wrapMemoryOp<any>('memory_load', () =>
            memory.loadMemoryVariables({ input: userMessage }),
          );
          chatHistory = (vars.chat_history ?? vars.history ?? []) as unknown[];
        } catch { /* non-fatal */ }
      }

      const messages: unknown[] = [
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
      const cancelSignal =
        typeof this.getExecutionCancelSignal === 'function'
          ? this.getExecutionCancelSignal()
          : undefined;

      agentLoop: for (let iter = 0; iter < maxIterations; iter++) {
        iterations = iter + 1;

        // ── wrapModelCall ──────────────────────────────────────────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let response: any;
        try {
          response = await middleware.wrapModelCall(messages, () =>
            boundModel.invoke(messages, { signal: cancelSignal }),
          );
        } catch (err) {
          mapGovernanceError(err, this, i);
          throw err;
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

        // ── wrapToolCall per tool ──────────────────────────────────────────
        for (const toolCall of toolCalls) {
          toolCallCount++;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tool = tools.find((t: any) => t.name === toolCall.name);
          if (!tool) {
            throw new NodeOperationError(
              this.getNode(),
              `Tool "${toolCall.name}" is not connected.`,
              { itemIndex: i },
            );
          }

          let toolResult: string;
          try {
            const raw = await middleware.wrapToolCall(toolCall.name, toolCall.args, () =>
              tool.invoke(toolCall.args),
            );
            toolResult = typeof raw === 'string' ? raw : JSON.stringify(raw);
          } catch (err) {
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
      } catch (err) {
        mapGovernanceError(err, this, i);
        throw err;
      }

      // Apply output redaction from WorkflowCompleted guardrails
      const gr =
        completedVerdict?.guardrails_result ??
        (completedVerdict as Record<string, unknown> | null | undefined)?.guardrailsResult as
          | Record<string, unknown>
          | undefined;
      if (gr?.redacted_input && gr.input_type === 'activity_output') {
        finalOutput = String(gr.redacted_input);
      }

      // ── Save to memory ─────────────────────────────────────────────────────
      if (memory) {
        try {
          await middleware.wrapMemoryOp('memory_save', () =>
            memory.saveContext({ input: userMessage }, { output: finalOutput }),
          );
        } catch { /* non-fatal */ }
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
}
