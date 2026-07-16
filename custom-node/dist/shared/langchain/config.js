"use strict";
/**
 * Governance configuration.
 *
 * Mirrors OpenBoxLangChainMiddlewareOptions + GovernanceConfig in middleware.py.
 * The Python SDK has these in separate classes; we merge them here since
 * TypeScript doesn't have dataclasses and the separation adds no value.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_APPROVAL_MAX_WAIT_MS = exports.ALL_DATABASE_DRIVERS = void 0;
exports.mergeConfig = mergeConfig;
exports.ALL_DATABASE_DRIVERS = ['pg', 'mysql2', 'mongodb', 'redis', 'ioredis'];
const consoleLogger = {
    warn(message, meta) {
        // eslint-disable-next-line no-console
        if (meta !== undefined)
            console.warn(`[openbox] ${message}`, meta);
        // eslint-disable-next-line no-console
        else
            console.warn(`[openbox] ${message}`);
    },
};
function envNumber(name) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const env = require('process').env;
    const raw = env[name];
    if (raw == null || raw.trim() === '')
        return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}
/**
 * Default HITL max wait — 1 hour, comfortably above the typical server-side
 * approval expiry (~30 min). Matches openbox-langchain-sdk-ts's
 * DEFAULT_APPROVAL_MAX_WAIT_MS. Previously hardcoded to 5 minutes here, which
 * could time out a human approver who was still legitimately working through
 * the request.
 */
exports.DEFAULT_APPROVAL_MAX_WAIT_MS = 60 * 60 * 1000;
/** merge_config() — mirrors openbox_langgraph.config.merge_config */
function mergeConfig(opts) {
    const databases = opts.databases
        ?? new Set((opts.instrumentDatabases ?? true) ? exports.ALL_DATABASE_DRIVERS : []);
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
            pollIntervalMs: opts.hitl?.pollIntervalMs ?? envNumber('OPENBOX_LANGCHAIN_HITL_POLL_INTERVAL_MS') ?? 5000,
            timeoutMs: opts.hitl?.timeoutMs !== undefined
                ? opts.hitl.timeoutMs
                : envNumber('OPENBOX_LANGCHAIN_HITL_TIMEOUT_MS') ?? exports.DEFAULT_APPROVAL_MAX_WAIT_MS,
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
        databases,
        logger: opts.logger ?? consoleLogger,
    };
}
