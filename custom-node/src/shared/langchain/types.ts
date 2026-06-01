/**
 * Core types for the OpenBox LangChain governance SDK (TypeScript port).
 *
 * Mirrors openbox_langgraph/types.py — identical field names so events are
 * interchangeable with the Python SDK and Core classifies them the same way.
 */

export type VerdictArm = 'allow' | 'monitor' | 'constrain' | 'block' | 'halt' | 'require_approval';

export interface GuardrailsResult {
  input_type?: 'activity_input' | 'activity_output';
  redacted_input?: unknown;
  validation_passed?: boolean;
  reasons?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface GovernanceVerdictResponse {
  arm?: VerdictArm;
  verdict?: string;
  action?: string;
  reason?: string;
  risk_score?: number;
  riskScore?: number;
  approval_id?: string;
  approvalId?: string;
  guardrails_result?: GuardrailsResult;
  guardrailsResult?: GuardrailsResult;
  [key: string]: unknown;
}

/**
 * Mirrors LangChainGovernanceEvent dataclass. All optional fields that are
 * not always present are left optional so partial construction is ergonomic.
 */
export interface LangChainGovernanceEvent {
  source: 'workflow-telemetry';
  timestamp: string;
  workflow_id: string;
  run_id: string;
  workflow_type: string;
  task_queue?: string;
  session_id?: string;
  event_type: string;
  activity_id?: string;
  activity_type?: string;
  activity_input?: unknown[];
  activity_output?: unknown;
  status?: 'completed' | 'failed';
  duration_ms?: number;
  error?: unknown;
  spans?: unknown[];
  span_count?: number;
  workflow_output?: unknown;
  // SignalReceived
  signal_name?: string;
  signal_args?: unknown[];
  // LLM events
  prompt?: string;
  llm_model?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  has_tool_calls?: boolean;
  completion?: string;
  // Tool events
  tool_name?: string;
  tool_type?: string;
  // OTel hook layer (Layer 2) — mirrors Python SDK hook_governance._build_payload()
  hook_trigger?: boolean;
  [key: string]: unknown;
}

/** rfc3339_now() — mirrors openbox_langgraph.types.rfc3339_now */
export function rfc3339Now(): string {
  return new Date().toISOString();
}

/** safe_serialize() — mirrors openbox_langgraph.types.safe_serialize */
export function safeSerialize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

/** uuid4-equivalent using crypto-quality hex. Mirrors uuid.uuid4().hex in Python. */
export function hexId(len: number = 32): string {
  return Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}
