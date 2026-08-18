import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { IExecuteFunctions } from 'n8n-workflow';

// Replace the real middleware with fully-controllable mocks — these tests
// exercise the node's OWN plumbing (fallback retry, streaming chunk
// emission), not the middleware's governance logic, which is already
// covered by LangchainMiddleware.test.ts.
const mockBeforeAgent = vi.fn();
const mockAfterAgent = vi.fn();
const mockWrapModelCall = vi.fn();
const mockWrapMemoryOp = vi.fn();
const mockWrapToolCall = vi.fn();

vi.mock('../shared/langchain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/langchain')>();
  return {
    ...actual,
    // Must be a real function (not an arrow) — the node calls this with
    // `new`, and only a function-form mock implementation can be invoked
    // as a constructor.
    OpenBoxLangChainMiddleware: vi.fn().mockImplementation(function () {
      return {
        _config: {},
        beforeAgent: mockBeforeAgent,
        afterAgent: mockAfterAgent,
        wrapModelCall: mockWrapModelCall,
        wrapMemoryOp: mockWrapMemoryOp,
        wrapToolCall: mockWrapToolCall,
      };
    }),
  };
});

import {
  OpenBoxAgent,
  getOpenBoxAgentInputs,
  emitStreamChunks,
  flattenConnectedTools,
  resolveSessionId,
} from '../nodes/OpenBoxAgent/OpenBoxAgent.node';

/** The intermediate-step shape the official Agent node emits. */
interface Step {
  action: { tool: string; toolInput: Record<string, unknown>; log: string; toolCallId?: string };
  observation: string;
}

/** Minimal stand-in for a connected n8n tool. */
function fakeTool(name: string, impl: (args: unknown) => unknown = () => 'ok') {
  return { name, invoke: vi.fn(async (args: unknown) => impl(args)) };
}

interface FakeCtxOptions {
  needsFallback?: boolean;
  hasFallbackConnection?: boolean;
  enableStreaming?: boolean;
  isStreaming?: boolean;
  returnIntermediateSteps?: boolean;
  onToolError?: 'returnToModel' | 'stopAgent';
  toolConnectionData?: unknown;
  itemJson?: Record<string, unknown>;
}

function makeCtx(opts: FakeCtxOptions = {}) {
  const parameters: Record<string, unknown> = {
    needsFallback: opts.needsFallback ?? false,
    options: {
      enableStreaming: opts.enableStreaming ?? false,
      ...(opts.returnIntermediateSteps === undefined
        ? {}
        : { returnIntermediateSteps: opts.returnIntermediateSteps }),
      ...(opts.onToolError === undefined ? {} : { onToolError: opts.onToolError }),
    },
    promptType: 'define',
    text: 'hello',
    governance: {},
  };
  const sendChunk = vi.fn();

  const ctx = {
    getInputData: () => [{ json: opts.itemJson ?? {} }],
    continueOnFail: () => false,
    getInputConnectionData: async (connectionType: string, _itemIndex: number, inputIndex?: number) => {
      if (connectionType === 'ai_languageModel') {
        if (inputIndex === 1) return (opts.hasFallbackConnection ?? true) ? {} : null;
        // bindTools must exist — the node binds connected tools to the model.
        return { bindTools: (t: unknown[]) => ({ _bound: t }) };
      }
      if (connectionType === 'ai_tool') return opts.toolConnectionData ?? [];
      if (connectionType === 'ai_memory') return null;
      return null;
    },
    getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) =>
      name in parameters ? parameters[name] : fallback,
    getNode: () => ({ name: 'Test Node' }),
    getExecutionId: () => 'exec-1',
    getWorkflow: () => ({ id: 'wf-1' }),
    isStreaming: () => opts.isStreaming ?? false,
    sendChunk,
  };

  return { ctx: ctx as unknown as IExecuteFunctions, sendChunk };
}

beforeEach(() => {
  mockBeforeAgent.mockReset().mockResolvedValue({ workflowId: 'w', runId: 'r' });
  mockAfterAgent.mockReset().mockResolvedValue(null);
  mockWrapModelCall.mockReset();
  mockWrapMemoryOp.mockReset();
  // By default governance is transparent: run the wrapped tool for real.
  mockWrapToolCall
    .mockReset()
    .mockImplementation((_turn: unknown, _name: string, _args: unknown, fn: () => unknown) => fn());
});

describe('getOpenBoxAgentInputs', () => {
  it('keeps the original single Chat Model port when fallback is disabled (regression guard)', () => {
    const inputs = getOpenBoxAgentInputs(false) as Array<{ type: string; displayName?: string }>;
    const languageModelPorts = inputs.filter((i) => i.type === 'ai_languageModel');
    expect(languageModelPorts).toHaveLength(1);
    expect(languageModelPorts[0].displayName).toBe('Chat Model');
    expect(inputs.map((i) => i.type)).toEqual(['main', 'ai_languageModel', 'ai_memory', 'ai_tool']);
  });

  it('adds a second Fallback Model port when fallback is enabled', () => {
    const inputs = getOpenBoxAgentInputs(true) as Array<{ type: string; displayName?: string }>;
    const languageModelPorts = inputs.filter((i) => i.type === 'ai_languageModel');
    expect(languageModelPorts).toHaveLength(2);
    expect(languageModelPorts[0].displayName).toBe('Chat Model');
    expect(languageModelPorts[1].displayName).toBe('Fallback Model');
  });

  it('embeds as valid, self-contained JS in the node\'s inputs ExpressionString', () => {
    // This is the actual mechanism n8n evaluates server-side (only
    // $parameter in scope) — proves the .toString() embedding isn't just
    // syntactically plausible but genuinely produces working, self-contained
    // JS, which a future edit referencing an outer closure variable would break.
    const node = new OpenBoxAgent();
    const exprString = node.description.inputs as unknown as string;
    expect(exprString.startsWith('={{')).toBe(true);
    expect(exprString.endsWith('}}')).toBe(true);
    const inner = exprString.slice(3, -2);

    const evalWithFallback = (needsFallback: boolean) => {
      // Consumed by eval(inner) below, which the linter cannot see into.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const $parameter = { needsFallback };
      return eval(inner);
    };

    expect(evalWithFallback(false)).toEqual(getOpenBoxAgentInputs(false));
    expect(evalWithFallback(true)).toEqual(getOpenBoxAgentInputs(true));
  });
});

describe('emitStreamChunks', () => {
  it('emits begin, fixed-size chunked items, and end for a given string', () => {
    const sendChunk = vi.fn();
    emitStreamChunks({ sendChunk }, 2, 'a'.repeat(90), 40);
    expect(sendChunk).toHaveBeenNthCalledWith(1, 'begin', 2);
    expect(sendChunk).toHaveBeenNthCalledWith(2, 'item', 2, 'a'.repeat(40));
    expect(sendChunk).toHaveBeenNthCalledWith(3, 'item', 2, 'a'.repeat(40));
    expect(sendChunk).toHaveBeenNthCalledWith(4, 'item', 2, 'a'.repeat(10));
    expect(sendChunk).toHaveBeenNthCalledWith(5, 'end', 2);
    expect(sendChunk).toHaveBeenCalledTimes(5);
  });

  it('still sends begin/end for an empty string', () => {
    const sendChunk = vi.fn();
    emitStreamChunks({ sendChunk }, 0, '');
    expect(sendChunk).toHaveBeenNthCalledWith(1, 'begin', 0);
    expect(sendChunk).toHaveBeenNthCalledWith(2, 'end', 0);
    expect(sendChunk).toHaveBeenCalledTimes(2);
  });
});

describe('OpenBoxAgent.execute — fallback model', () => {
  it('retries via the fallback model when the primary call fails, as its own wrapModelCall', async () => {
    mockWrapModelCall
      .mockRejectedValueOnce(new Error('primary down'))
      .mockResolvedValueOnce({ content: 'fallback answer', tool_calls: [] });

    const { ctx } = makeCtx({ needsFallback: true, hasFallbackConnection: true });
    const result = await new OpenBoxAgent().execute.call(ctx);

    expect(mockWrapModelCall).toHaveBeenCalledTimes(2);
    expect(result[0][0].json.output).toBe('fallback answer');
  });

  it('surfaces the original error when no fallback is connected and the primary call fails (unchanged today\'s behavior)', async () => {
    mockWrapModelCall.mockRejectedValueOnce(new Error('primary down'));

    const { ctx } = makeCtx({ needsFallback: false });
    await expect(new OpenBoxAgent().execute.call(ctx)).rejects.toThrow(/primary down/);
    expect(mockWrapModelCall).toHaveBeenCalledTimes(1);
  });

  it('throws up front when needsFallback is true but nothing is connected to the Fallback Model input', async () => {
    const { ctx } = makeCtx({ needsFallback: true, hasFallbackConnection: false });
    await expect(new OpenBoxAgent().execute.call(ctx)).rejects.toThrow(/Fallback Model/);
    expect(mockWrapModelCall).not.toHaveBeenCalled();
  });

  it('surfaces the fallback error when both the primary and fallback calls fail', async () => {
    mockWrapModelCall
      .mockRejectedValueOnce(new Error('primary down'))
      .mockRejectedValueOnce(new Error('fallback also down'));

    const { ctx } = makeCtx({ needsFallback: true, hasFallbackConnection: true });
    await expect(new OpenBoxAgent().execute.call(ctx)).rejects.toThrow(/fallback also down/);
    expect(mockWrapModelCall).toHaveBeenCalledTimes(2);
  });
});

describe('OpenBoxAgent.execute — streaming', () => {
  it('emits stream chunks with the final governed output when streaming is enabled and the trigger is actually streaming', async () => {
    mockWrapModelCall.mockResolvedValueOnce({ content: 'the answer', tool_calls: [] });

    const { ctx, sendChunk } = makeCtx({ enableStreaming: true, isStreaming: true });
    await new OpenBoxAgent().execute.call(ctx);

    expect(sendChunk).toHaveBeenNthCalledWith(1, 'begin', 0);
    expect(sendChunk).toHaveBeenCalledWith('item', 0, 'the answer');
    expect(sendChunk).toHaveBeenLastCalledWith('end', 0);
  });

  it('never calls sendChunk when the Enable Streaming option is off, even if the trigger is streaming', async () => {
    mockWrapModelCall.mockResolvedValueOnce({ content: 'the answer', tool_calls: [] });

    const { ctx, sendChunk } = makeCtx({ enableStreaming: false, isStreaming: true });
    await new OpenBoxAgent().execute.call(ctx);

    expect(sendChunk).not.toHaveBeenCalled();
  });

  it('never calls sendChunk when the trigger itself is not streaming, even if the option is on', async () => {
    mockWrapModelCall.mockResolvedValueOnce({ content: 'the answer', tool_calls: [] });

    const { ctx, sendChunk } = makeCtx({ enableStreaming: true, isStreaming: false });
    await new OpenBoxAgent().execute.call(ctx);

    expect(sendChunk).not.toHaveBeenCalled();
  });

  it('still returns the normal single output item regardless of streaming', async () => {
    mockWrapModelCall.mockResolvedValueOnce({ content: 'the answer', tool_calls: [] });

    const { ctx } = makeCtx({ enableStreaming: true, isStreaming: true });
    const result = await new OpenBoxAgent().execute.call(ctx);

    expect(result[0]).toHaveLength(1);
    expect(result[0][0].json.output).toBe('the answer');
  });
});

// ── Gap 2: toolkit flattening (MCP / Composio) ────────────────────────────────
describe('flattenConnectedTools', () => {
  it('passes plain tools through unchanged', () => {
    const a = fakeTool('a');
    const b = fakeTool('b');
    expect(flattenConnectedTools([a, b])).toEqual([a, b]);
  });

  it('unwraps a getTools() toolkit — the mcpClientTool/Composio shape', () => {
    const inner = [fakeTool('composio_gmail_send'), fakeTool('composio_slack_post')];
    const toolkit = { getTools: () => inner };
    expect(flattenConnectedTools([toolkit])).toEqual(inner);
  });

  it('unwraps a toolkit exposing a plain tools array', () => {
    const inner = [fakeTool('x')];
    expect(flattenConnectedTools([{ tools: inner }])).toEqual(inner);
  });

  it('handles toolkits and plain tools mixed together, as on a real canvas', () => {
    const plain = fakeTool('get_skills');
    const mcp = [fakeTool('mcp_one'), fakeTool('mcp_two')];
    const result = flattenConnectedTools([plain, { getTools: () => mcp }]);
    expect(result.map((t) => (t as { name: string }).name)).toEqual([
      'get_skills',
      'mcp_one',
      'mcp_two',
    ]);
  });

  it('treats a directly-callable object as a tool even if it also has a tools property', () => {
    const tool = { ...fakeTool('callable'), tools: [fakeTool('should_not_surface')] };
    expect(flattenConnectedTools([tool]).map((t) => (t as { name: string }).name)).toEqual([
      'callable',
    ]);
  });

  it('deduplicates by name, first wins, so tool dispatch is never ambiguous', () => {
    const first = fakeTool('dup');
    const second = fakeTool('dup');
    const result = flattenConnectedTools([first, second]);
    expect(result).toEqual([first]);
  });

  it('drops non-tools instead of passing them to bindTools', () => {
    expect(flattenConnectedTools([null, undefined, 'nope', 42, {}])).toEqual([]);
  });

  it('returns an empty list for a null/undefined port', () => {
    expect(flattenConnectedTools(null)).toEqual([]);
    expect(flattenConnectedTools(undefined)).toEqual([]);
  });

  it('survives a toolkit whose getTools() throws', () => {
    const good = fakeTool('good');
    const bad = { getTools: () => { throw new Error('mcp server unreachable'); } };
    expect(flattenConnectedTools([bad, good])).toEqual([good]);
  });

  it('terminates on a self-referential toolkit', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.tools = [cyclic, fakeTool('reachable')];
    expect(flattenConnectedTools([cyclic]).map((t) => (t as { name: string }).name)).toEqual([
      'reachable',
    ]);
  });

  it('makes toolkit tools visible to the agent end to end', async () => {
    const mcpTool = fakeTool('composio_send', () => 'sent');
    mockWrapModelCall
      .mockResolvedValueOnce({
        content: '',
        tool_calls: [{ id: 't1', name: 'composio_send', args: { to: 'a@b.c' } }],
      })
      .mockResolvedValueOnce({ content: 'done', tool_calls: [] });

    const { ctx } = makeCtx({ toolConnectionData: [{ getTools: () => [mcpTool] }] });
    const result = await new OpenBoxAgent().execute.call(ctx);

    expect(mcpTool.invoke).toHaveBeenCalledWith({ to: 'a@b.c' });
    expect(result[0][0].json.output).toBe('done');
  });
});

// ── Gap 3: session id resolution ──────────────────────────────────────────────
describe('resolveSessionId', () => {
  it('finds a top-level camelCase sessionId', () => {
    expect(resolveSessionId({ sessionId: 's-1' })).toBe('s-1');
  });

  it('finds a top-level snake_case session_id', () => {
    expect(resolveSessionId({ session_id: 's-2' })).toBe('s-2');
  });

  it('finds session_id nested under body — the real n8n webhook shape', () => {
    expect(resolveSessionId({ body: { session_id: 's-3', user_mssg: 'hi' } })).toBe('s-3');
  });

  it('prefers the top level over body when both are present', () => {
    expect(resolveSessionId({ sessionId: 'top', body: { session_id: 'nested' } })).toBe('top');
  });

  it('coerces a numeric session id to a string', () => {
    expect(resolveSessionId({ body: { session_id: 12345 } })).toBe('12345');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveSessionId({ sessionId: '  s-4 ' })).toBe('s-4');
  });

  it('returns undefined when absent, empty, or the wrong type', () => {
    expect(resolveSessionId({})).toBeUndefined();
    expect(resolveSessionId({ sessionId: '   ' })).toBeUndefined();
    expect(resolveSessionId({ sessionId: { nope: true } })).toBeUndefined();
    expect(resolveSessionId({ body: 'not-an-object' })).toBeUndefined();
  });
});

// ── Gap 1: intermediate steps ─────────────────────────────────────────────────
describe('OpenBoxAgent.execute — returnIntermediateSteps', () => {
  const twoToolTurn = () => {
    mockWrapModelCall
      .mockResolvedValueOnce({
        content: '',
        tool_calls: [{ id: 't1', name: 'get_skills', args: { skill_name: 'seo' } }],
      })
      .mockResolvedValueOnce({ content: 'final answer', tool_calls: [] });
  };

  it('emits intermediateSteps in the official action/observation shape', async () => {
    twoToolTurn();
    const { ctx } = makeCtx({
      returnIntermediateSteps: true,
      toolConnectionData: [fakeTool('get_skills', () => 'skill content')],
    });
    const result = await new OpenBoxAgent().execute.call(ctx);

    const steps = result[0][0].json.intermediateSteps as Step[];
    expect(steps).toHaveLength(1);
    expect(steps[0].action.tool).toBe('get_skills');
    expect(steps[0].action.toolInput).toEqual({ skill_name: 'seo' });
    expect(steps[0].observation).toBe('skill content');
    expect(result[0][0].json.output).toBe('final answer');
  });

  it('omits the key entirely when the option is off (unchanged default output)', async () => {
    twoToolTurn();
    const { ctx } = makeCtx({
      returnIntermediateSteps: false,
      toolConnectionData: [fakeTool('get_skills', () => 'skill content')],
    });
    const result = await new OpenBoxAgent().execute.call(ctx);
    expect(result[0][0].json).not.toHaveProperty('intermediateSteps');
  });

  it('emits an empty array when the option is on but no tool was called', async () => {
    mockWrapModelCall.mockResolvedValueOnce({ content: 'no tools needed', tool_calls: [] });
    const { ctx } = makeCtx({ returnIntermediateSteps: true });
    const result = await new OpenBoxAgent().execute.call(ctx);
    expect(result[0][0].json.intermediateSteps).toEqual([]);
  });

  it('records a failed tool call as a step with the error as its observation', async () => {
    mockWrapModelCall
      .mockResolvedValueOnce({
        content: '',
        tool_calls: [{ id: 't1', name: 'flaky', args: {} }],
      })
      .mockResolvedValueOnce({ content: 'recovered', tool_calls: [] });

    const { ctx } = makeCtx({
      returnIntermediateSteps: true,
      toolConnectionData: [
        fakeTool('flaky', () => { throw new Error('upstream 500'); }),
      ],
    });
    const result = await new OpenBoxAgent().execute.call(ctx);

    const steps = result[0][0].json.intermediateSteps as Step[];
    expect(steps).toHaveLength(1);
    expect(steps[0].observation).toContain('upstream 500');
  });

  it('serializes non-string tool results into the observation', async () => {
    mockWrapModelCall
      .mockResolvedValueOnce({ content: '', tool_calls: [{ id: 't1', name: 'obj', args: {} }] })
      .mockResolvedValueOnce({ content: 'done', tool_calls: [] });

    const { ctx } = makeCtx({
      returnIntermediateSteps: true,
      toolConnectionData: [fakeTool('obj', () => ({ rows: [1, 2] }))],
    });
    const result = await new OpenBoxAgent().execute.call(ctx);
    const steps = result[0][0].json.intermediateSteps as Step[];
    expect(steps[0].observation).toBe('{"rows":[1,2]}');
  });
});

// ── Gap 4: tool errors returned to the model ──────────────────────────────────
describe('OpenBoxAgent.execute — onToolError', () => {
  it('feeds a thrown tool error back to the model and lets the agent recover (new default)', async () => {
    mockWrapModelCall
      .mockResolvedValueOnce({ content: '', tool_calls: [{ id: 't1', name: 'flaky', args: {} }] })
      .mockResolvedValueOnce({ content: 'worked around it', tool_calls: [] });

    const { ctx } = makeCtx({
      toolConnectionData: [fakeTool('flaky', () => { throw new Error('boom'); })],
    });
    const result = await new OpenBoxAgent().execute.call(ctx);

    // The model got a second turn — the run did not end at the failure.
    expect(mockWrapModelCall).toHaveBeenCalledTimes(2);
    expect(result[0][0].json.output).toBe('worked around it');
  });

  it('feeds an n8n string-encoded HTTP error back to the model too', async () => {
    mockWrapModelCall
      .mockResolvedValueOnce({ content: '', tool_calls: [{ id: 't1', name: 'http', args: {} }] })
      .mockResolvedValueOnce({ content: 'recovered', tool_calls: [] });

    const { ctx } = makeCtx({
      toolConnectionData: [
        fakeTool('http', () => 'HTTP 503 There was an error: "service unavailable"'),
      ],
    });
    const result = await new OpenBoxAgent().execute.call(ctx);
    expect(mockWrapModelCall).toHaveBeenCalledTimes(2);
    expect(result[0][0].json.output).toBe('recovered');
  });

  it('sends a ToolMessage for every tool_call id even when the tool failed', async () => {
    // A missing ToolMessage for an issued tool_call id makes the next model
    // request malformed — this guards the recovery path against that.
    let secondCallMessages: unknown[] = [];
    mockWrapModelCall
      .mockResolvedValueOnce({ content: '', tool_calls: [{ id: 't1', name: 'flaky', args: {} }] })
      .mockImplementationOnce(async (_turn: unknown, messages: unknown[]) => {
        secondCallMessages = messages;
        return { content: 'ok', tool_calls: [] };
      });

    const { ctx } = makeCtx({
      toolConnectionData: [fakeTool('flaky', () => { throw new Error('boom'); })],
    });
    await new OpenBoxAgent().execute.call(ctx);

    const toolMessages = secondCallMessages.filter((m) => {
      const msg = m as { tool_call_id?: string; lc_kwargs?: { tool_call_id?: string } };
      return msg?.tool_call_id === 't1' || msg?.lc_kwargs?.tool_call_id === 't1';
    });
    expect(toolMessages).toHaveLength(1);
  });

  it('reports an unconnected tool back to the model instead of failing the run', async () => {
    mockWrapModelCall
      .mockResolvedValueOnce({ content: '', tool_calls: [{ id: 't1', name: 'ghost', args: {} }] })
      .mockResolvedValueOnce({ content: 'used something else', tool_calls: [] });

    const { ctx } = makeCtx({ toolConnectionData: [fakeTool('real')] });
    const result = await new OpenBoxAgent().execute.call(ctx);
    expect(result[0][0].json.output).toBe('used something else');
  });

  it('stops the agent and returns the error when onToolError is stopAgent (previous behaviour)', async () => {
    mockWrapModelCall.mockResolvedValueOnce({
      content: '',
      tool_calls: [{ id: 't1', name: 'flaky', args: {} }],
    });

    const { ctx } = makeCtx({
      onToolError: 'stopAgent',
      toolConnectionData: [fakeTool('flaky', () => { throw new Error('boom'); })],
    });
    const result = await new OpenBoxAgent().execute.call(ctx);

    expect(mockWrapModelCall).toHaveBeenCalledTimes(1);
    expect(result[0][0].json.output).toBe('Tool "flaky" failed: boom');
  });

  it('still aborts the run on a governance halt, whatever onToolError says', async () => {
    const { GovernanceHaltError } = await import('../shared/langchain');
    mockWrapModelCall.mockResolvedValueOnce({
      content: '',
      tool_calls: [{ id: 't1', name: 'blocked', args: {} }],
    });
    mockWrapToolCall.mockImplementationOnce(async () => {
      throw new GovernanceHaltError('Activity rejected: policy X');
    });

    const { ctx } = makeCtx({ toolConnectionData: [fakeTool('blocked')] });
    // Halts surface under a fixed title, with the specific reason in the
    // NodeOperationError description (see mapGovernanceError).
    await expect(new OpenBoxAgent().execute.call(ctx)).rejects.toThrow(
      /governance halted the workflow/,
    );
    // The agent stopped at the halt — no second model turn, unlike the
    // ordinary tool-failure recovery path above.
    expect(mockWrapModelCall).toHaveBeenCalledTimes(1);
  });
});

// ── Ignored-URL matching for a self-hosted Core on a non-default port ─────────
describe('span_processor URL reconstruction', () => {
  it('keeps an explicit port so a self-hosted Core still matches its ignored prefix', async () => {
    const { addIgnoredPrefix, shouldIgnore } = await import('../shared/langchain/span_processor');
    addIgnoredPrefix('http://127.0.0.1:9902');
    // Reconstructed from { hostname, port, path } — dropping the port here
    // made the governance client instrument its own calls to Core and loop.
    expect(shouldIgnore('http://127.0.0.1:9902/api/v1/governance/evaluate')).toBe(true);
    // A different port on the same host must NOT be swallowed.
    expect(shouldIgnore('http://127.0.0.1:9901/backup-weather')).toBe(false);
  });
});
