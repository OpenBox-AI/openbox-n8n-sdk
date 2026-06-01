"use strict";
/**
 * Governance configuration.
 *
 * Mirrors OpenBoxLangChainMiddlewareOptions + GovernanceConfig in middleware.py.
 * The Python SDK has these in separate classes; we merge them here since
 * TypeScript doesn't have dataclasses and the separation adds no value.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeConfig = mergeConfig;
/** merge_config() — mirrors openbox_langgraph.config.merge_config */
function mergeConfig(opts) {
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
