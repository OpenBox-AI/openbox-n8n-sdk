"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GovernanceAuthError = exports.SoftGovernanceError = void 0;
exports.getOpenBoxCredentials = getOpenBoxCredentials;
exports.openboxRequest = openboxRequest;
/* eslint-disable @n8n/community-nodes/require-node-api-error */
const n8n_workflow_1 = require("n8n-workflow");
const OpenBoxApi_credentials_1 = require("../credentials/OpenBoxApi.credentials");
const signing_1 = require("./signing");
const OPENBOX_TIMEOUT_MS = 35_000;
async function getOpenBoxCredentials(ctx) {
    try {
        const raw = await ctx.getCredentials('openBoxApi');
        if (raw && raw.apiKey) {
            return (0, OpenBoxApi_credentials_1.normalizeOpenBoxCredentials)(raw);
        }
    }
    catch {
        // fall through
    }
    throw new n8n_workflow_1.NodeApiError(ctx.getNode(), {
        message: 'OpenBox API key not set',
        description: 'Attach an OpenBox credential to this node.',
    });
}
async function openboxRequest(ctx, options) {
    const credentials = await getOpenBoxCredentials(ctx);
    const url = `${credentials.openboxUrl}${options.path}`;
    // Serialize body before signing so the bytes we hash == the bytes we send.
    const bodyBytes = (0, signing_1.serializeBody)(options.body ?? null);
    const headers = (0, signing_1.buildSignedHeaders)(options.method, options.path, bodyBytes, credentials.apiKey, credentials.agentDid, credentials.agentPrivateKey);
    if (options.traceId) {
        headers['X-OpenBox-Trace-Id'] = options.traceId;
    }
    const requestOptions = {
        method: options.method,
        url,
        headers,
        json: false,
        timeout: options.timeoutMs ?? OPENBOX_TIMEOUT_MS,
        body: bodyBytes.length > 0 ? bodyBytes : undefined,
        qs: options.qs,
        returnFullResponse: false,
        ignoreHttpStatusErrors: false,
    };
    try {
        const raw = await ctx.helpers.httpRequest(requestOptions);
        if (typeof raw === 'string')
            return JSON.parse(raw);
        if (Buffer.isBuffer(raw))
            return JSON.parse(raw.toString('utf-8'));
        return raw;
    }
    catch (err) {
        const statusCode = extractHttpStatusCode(err);
        if (statusCode === 401 || statusCode === 403) {
            // Auth/signing failures always hard-fail, regardless of onApiError —
            // a revoked/invalid key must never silently degrade to "run ungoverned".
            throw new GovernanceAuthError(err instanceof Error ? err.message : String(err), statusCode, err);
        }
        throw new SoftGovernanceError(err instanceof Error ? err.message : String(err), err);
    }
}
/**
 * Best-effort extraction of an HTTP status code from whatever shape n8n's
 * httpRequest helper (or an upstream NodeApiError) throws. Different n8n
 * versions/transports surface this differently, so several paths are tried.
 */
function extractHttpStatusCode(err) {
    if (err == null || typeof err !== 'object')
        return null;
    const e = err;
    const candidates = [
        e.statusCode,
        e.httpCode,
        e.response?.statusCode,
        e.response?.status,
        e.cause?.statusCode,
        e.cause?.response?.status,
    ];
    for (const c of candidates) {
        const n = typeof c === 'string' ? Number(c) : c;
        if (typeof n === 'number' && Number.isFinite(n))
            return n;
    }
    return null;
}
/**
 * Marker error for governance/network failures. Callers that can safely
 * continue (fail-open) catch this; callers that must fail hard re-throw it
 * as a NodeApiError.
 */
class SoftGovernanceError extends Error {
    cause;
    constructor(message, cause) {
        super(message);
        this.name = 'SoftGovernanceError';
        this.cause = cause;
    }
}
exports.SoftGovernanceError = SoftGovernanceError;
/**
 * A 401/403 from Core. Always a hard failure — never caught as fail-open,
 * regardless of the configured onApiError policy.
 */
class GovernanceAuthError extends Error {
    statusCode;
    cause;
    constructor(message, statusCode, cause) {
        super(message);
        this.name = 'GovernanceAuthError';
        this.statusCode = statusCode;
        this.cause = cause;
    }
}
exports.GovernanceAuthError = GovernanceAuthError;
