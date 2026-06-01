/**
 * Span builders for governance evaluate payloads.
 *
 * Two span types mirror the two layers of the Python SDK:
 *
 * Layer 1 — function_call spans (buildLlmSpan / buildToolSpan):
 *   Port of ts/src/governance/spans.ts. Sent inside LLMStarted/LLMCompleted
 *   and ToolStarted/ToolCompleted governance events. Core behavior rules gate
 *   on semantic_type + classifier attributes.
 *
 * Layer 2 — http_request spans (buildHttpRequestSpan):
 *   Mirror of Python SDK's _build_http_span_data() in http_governance_hooks.py.
 *   Sent as standalone ActivityStarted + hook_trigger:true events, replicating
 *   what the OTel httpx hooks produce when the LLM's HTTP request fires.
 *   These carry the actual request_body (prompt JSON) and response_body
 *   (completion JSON) so Core can inspect full OpenAI API content.
 */

const LLM_URL = 'https://api.openai.com/v1/chat/completions';

function hex(len: number): string {
  return Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function baseSpan(startMs: number, endMs?: number) {
  const startNs = startMs * 1_000_000;
  const endNs = endMs != null ? endMs * 1_000_000 : null;
  return {
    span_id: hex(16),
    trace_id: hex(32),
    parent_span_id: null,
    kind: 'CLIENT',
    stage: endMs != null ? 'completed' : 'started',
    start_time: startNs,
    end_time: endNs,
    duration_ns: endNs != null ? endNs - startNs : null,
    status: { code: 'OK', description: null },
    events: [] as never[],
    error: null,
  };
}

// ── Layer 1: function_call spans ──────────────────────────────────────────────

export function buildLlmSpan(opts: {
  prompt?: string;
  response?: string;
  startMs: number;
  endMs?: number;
}): Record<string, unknown> {
  return {
    ...baseSpan(opts.startMs, opts.endMs),
    name: 'llm.chat.completion',
    hook_type: 'function_call',
    semantic_type: 'llm_completion',
    attributes: {
      'gen_ai.system': 'n8n',
      'http.method': 'POST',
      'http.url': LLM_URL,
    },
    function: 'LLMCall',
    module: 'n8n',
    args: { prompt: opts.prompt ?? '', response: opts.response ?? '' },
    result: opts.response ?? null,
  };
}

export function buildToolSpan(opts: {
  toolName: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  startMs: number;
  endMs?: number;
}): Record<string, unknown> {
  return {
    ...baseSpan(opts.startMs, opts.endMs),
    kind: 'INTERNAL',
    name: `tool.${opts.toolName}`,
    hook_type: 'function_call',
    semantic_type: 'llm_tool_call',
    attributes: {
      'gen_ai.system': 'n8n',
      'http.method': 'POST',
      'http.url': LLM_URL,
    },
    function: `tool.${opts.toolName}`,
    module: 'n8n',
    args: { tool_name: opts.toolName, tool_input: opts.toolInput },
    result: opts.toolOutput ?? null,
  };
}

// ── Layer 2: http_request spans (OTel hook layer) ─────────────────────────────

/**
 * buildHttpRequestSpan — mirrors _build_http_span_data() in http_governance_hooks.py.
 *
 * Produces an http_request span with request_body / response_body so Core can
 * inspect the actual OpenAI API content (the Python SDK captures these via its
 * httpx OTel instrumentor; we synthesize them from LangChain's message/response).
 */
export function buildHttpRequestSpan(opts: {
  method: string;
  url: string;
  requestBody?: string;
  responseBody?: string;
  statusCode?: number;
  startMs: number;
  endMs?: number;
}): Record<string, unknown> {
  const startNs = opts.startMs * 1_000_000;
  const endNs = opts.endMs != null ? opts.endMs * 1_000_000 : null;
  const stage = opts.endMs != null ? 'completed' : 'started';
  const durationNs = endNs != null ? endNs - startNs : null;
  const error =
    opts.statusCode != null && opts.statusCode >= 400 ? `HTTP ${opts.statusCode}` : null;

  return {
    span_id: hex(16),
    trace_id: hex(32),
    parent_span_id: null,
    name: opts.url,
    kind: 'CLIENT',
    stage,
    start_time: startNs,
    end_time: endNs,
    duration_ns: durationNs,
    status: { code: error ? 'ERROR' : 'UNSET', description: error },
    events: [] as never[],
    // http_request hook fields (matches Python SDK root-level layout)
    hook_type: 'http_request',
    http_method: opts.method,
    http_url: opts.url,
    request_body: opts.requestBody ?? null,
    request_headers: null,
    response_body: opts.responseBody ?? null,
    response_headers: null,
    http_status_code: opts.statusCode ?? null,
    error,
    attributes: {
      'http.method': opts.method,
      'http.url': opts.url,
      'gen_ai.system': 'n8n',
    },
  };
}
