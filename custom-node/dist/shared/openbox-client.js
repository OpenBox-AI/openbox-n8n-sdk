"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GovernanceAuthError = exports.SoftGovernanceError = void 0;
exports.workloadHttpFor = workloadHttpFor;
exports.toGovernanceError = toGovernanceError;
exports.getOpenBoxCredentials = getOpenBoxCredentials;
exports.openboxRequest = openboxRequest;
/* eslint-disable @n8n/community-nodes/require-node-api-error */
const n8n_workflow_1 = require("n8n-workflow");
const OpenBoxApi_credentials_1 = require("../credentials/OpenBoxApi.credentials");
const ignored_urls_1 = require("./ignored-urls");
const signing_1 = require("./signing");
const workload_identity_1 = require("./workload-identity");
const OPENBOX_TIMEOUT_MS = 35_000;
/** Core's v1 paths and their v3 (workload identity) counterparts. */
const V3_PATHS = {
    '/api/v1/governance/evaluate': '/api/v3/governance/evaluate',
    '/api/v1/governance/approval': '/api/v3/governance/approval',
    '/api/v1/auth/validate': '/api/v3/auth/validate',
};
/** n8n's request helper as the raw transport for the workload bootstrap and token exchange. */
function workloadHttpFor(
// eslint-disable-next-line @typescript-eslint/no-explicit-any
helpers, timeoutMs) {
    return async ({ method, url, headers, body }) => {
        const response = await helpers.httpRequest({
            method,
            url,
            headers,
            body,
            json: false,
            timeout: timeoutMs,
            returnFullResponse: true,
            ignoreHttpStatusErrors: true,
        });
        const raw = response?.body;
        const text = typeof raw === 'string' ? raw
            : Buffer.isBuffer(raw) ? raw.toString('utf-8')
                : raw == null ? ''
                    : JSON.stringify(raw);
        return { status: Number(response?.statusCode ?? 0), body: text };
    };
}
/**
 * Map a workload-identity failure onto the client's error contract: network
 * trouble follows onApiError like any outage; a rejected or misconfigured
 * identity always fails closed.
 */
function toGovernanceError(err) {
    if (err.kind === 'network')
        return new SoftGovernanceError(err.message, err);
    return new GovernanceAuthError(err.message, err.statusCode ?? 0, err);
}
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
    const timeoutMs = options.timeoutMs ?? OPENBOX_TIMEOUT_MS;
    // Serialize body before signing so the bytes we hash == the bytes we send.
    const bodyBytes = (0, signing_1.serializeBody)(options.body ?? null);
    // v3 workload identity when the credential carries a workload key and Core
    // has an authority for the agent; otherwise the legacy v1 path (DID-signed
    // when a DID is configured).
    let workloadToken = null;
    let path = options.path;
    if (credentials.workloadPrivateKey && V3_PATHS[options.path]) {
        try {
            const auth = await (0, workload_identity_1.getWorkloadAuth)(workloadHttpFor(ctx.helpers, timeoutMs), {
                apiUrl: credentials.openboxUrl,
                apiKey: credentials.apiKey,
                privateKeyPem: credentials.workloadPrivateKey,
                coreHeaders: (0, signing_1.buildSignedHeaders)('GET', '/api/v3/auth/bootstrap', Buffer.alloc(0), credentials.apiKey),
            }, (document) => (0, ignored_urls_1.addIgnoredPrefix)(document.issuer));
            if (auth) {
                workloadToken = auth.token;
                path = V3_PATHS[options.path];
            }
        }
        catch (err) {
            if (err instanceof workload_identity_1.WorkloadIdentityError)
                throw toGovernanceError(err);
            throw err;
        }
    }
    const url = `${credentials.openboxUrl}${path}`;
    const headers = workloadToken != null
        ? {
            ...(0, signing_1.buildSignedHeaders)(options.method, path, bodyBytes, credentials.apiKey),
            [workload_identity_1.WORKLOAD_TOKEN_HEADER]: workloadToken,
        }
        : (0, signing_1.buildSignedHeaders)(options.method, path, bodyBytes, credentials.apiKey, credentials.agentDid, credentials.agentPrivateKey);
    if (options.traceId) {
        headers['X-OpenBox-Trace-Id'] = options.traceId;
    }
    const requestOptions = {
        method: options.method,
        url,
        headers,
        json: false,
        timeout: timeoutMs,
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
            // On v3 the token this request carried is discarded (Core does not tell
            // an expired token from a changed authority) and the request is not
            // replayed; the next one bootstraps again.
            if (workloadToken != null && credentials.workloadPrivateKey) {
                (0, workload_identity_1.invalidateWorkloadToken)({ apiUrl: credentials.openboxUrl, apiKey: credentials.apiKey, privateKeyPem: credentials.workloadPrivateKey }, workloadToken);
            }
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
