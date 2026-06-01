/**
 * Governance configuration.
 *
 * Mirrors OpenBoxLangChainMiddlewareOptions + GovernanceConfig in middleware.py.
 * The Python SDK has these in separate classes; we merge them here since
 * TypeScript doesn't have dataclasses and the separation adds no value.
 */

export interface OpenBoxLangChainMiddlewareOptions {
  /** Displayed as workflow_type in governance events. Mirrors agent_name param. */
  agentName?: string;
  sessionId?: string;
  /** task_queue field on all events. Defaults to "n8n". Python default: "langchain". */
  taskQueue?: string;
  onApiError?: 'fail_open' | 'fail_closed';
  governanceTimeout?: number;
  /** Maps tool name → tool_type tag sent on ToolStarted/ToolCompleted. */
  toolTypeMap?: Record<string, string>;
  /** Tool names whose governance events are suppressed entirely. */
  skipToolTypes?: Set<string>;
  sendChainStartEvent?: boolean;
  sendChainEndEvent?: boolean;
  sendLlmStartEvent?: boolean;
  sendLlmEndEvent?: boolean;
  sendToolStartEvent?: boolean;
  sendToolEndEvent?: boolean;
  hitl?: Partial<HITLConfig>;
  instrumentHttp?: boolean;
  instrumentFileIo?: boolean;
  instrumentDatabases?: boolean;
}

export interface HITLConfig {
  enabled: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
}

export interface GovernanceConfig {
  taskQueue: string;
  onApiError: 'fail_open' | 'fail_closed';
  governanceTimeout: number;
  toolTypeMap: Record<string, string>;
  skipToolTypes: Set<string>;
  sessionId?: string;
  agentName?: string;
  sendChainStartEvent: boolean;
  sendChainEndEvent: boolean;
  sendLlmStartEvent: boolean;
  sendLlmEndEvent: boolean;
  sendToolStartEvent: boolean;
  sendToolEndEvent: boolean;
  hitl: HITLConfig;
  instrumentHttp: boolean;
  instrumentFileIo: boolean;
  instrumentDatabases: boolean;
}

/** merge_config() — mirrors openbox_langgraph.config.merge_config */
export function mergeConfig(opts: OpenBoxLangChainMiddlewareOptions): GovernanceConfig {
  return {
    taskQueue: opts.taskQueue ?? 'n8n',
    onApiError: opts.onApiError ?? 'fail_open',
    governanceTimeout: opts.governanceTimeout ?? 30.0,
    toolTypeMap: opts.toolTypeMap ?? {},
    skipToolTypes: opts.skipToolTypes ?? new Set(),
    sessionId: opts.sessionId,
    agentName: opts.agentName,
    sendChainStartEvent: opts.sendChainStartEvent ?? true,
    sendChainEndEvent: opts.sendChainEndEvent ?? true,
    sendLlmStartEvent: opts.sendLlmStartEvent ?? true,
    sendLlmEndEvent: opts.sendLlmEndEvent ?? true,
    sendToolStartEvent: opts.sendToolStartEvent ?? true,
    sendToolEndEvent: opts.sendToolEndEvent ?? true,
    hitl: {
      enabled: opts.hitl?.enabled ?? true,
      pollIntervalMs: opts.hitl?.pollIntervalMs ?? 5000,
      timeoutMs: opts.hitl?.timeoutMs ?? 300000,
    },
    // HTTP instrumentation is always on (mirrors Python SDK wiring httpx by default).
    // File IO is off — file reads in n8n are almost always credential/config, not
    // user data worth governing.
    // DB instrumentation is on; node_instrumentation filters out n8n's own internal
    // postgres connection (DB_POSTGRESDB_HOST / DB_POSTGRESDB_DATABASE) so only
    // user-facing database tool calls produce spans.
    instrumentHttp: opts.instrumentHttp ?? true,
    instrumentFileIo: opts.instrumentFileIo ?? false,
    instrumentDatabases: opts.instrumentDatabases ?? true,
  };
}
