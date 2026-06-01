"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SoftGovernanceError = void 0;
exports.getOpenBoxCredentials = getOpenBoxCredentials;
exports.openboxRequest = openboxRequest;
const n8n_workflow_1 = require("n8n-workflow");
const OpenBoxApi_credentials_1 = require("../credentials/OpenBoxApi.credentials");
const signing_1 = require("./signing");
/**
 * Resolve OpenBox credentials. Falls back to environment variables when no
 * credential is attached (matching openboxLlm / Temporal SDK behaviour where
 * OPENBOX_API_KEY and OPENBOX_API_URL are the primary config path).
 */
async function getOpenBoxCredentials(ctx) {
    try {
        const raw = await ctx.getCredentials('openBoxApi');
        if (raw && raw.apiKey) {
            return (0, OpenBoxApi_credentials_1.normalizeOpenBoxCredentials)(raw);
        }
    }
    catch {
        // Credential not attached — fall through to env-var path
    }
    // Env-var fallback: mirrors the Temporal SDK's OPENBOX_API_KEY / OPENBOX_API_URL
    const envKey = process.env.OPENBOX_API_KEY ?? '';
    const envUrl = (process.env.OPENBOX_API_URL ?? 'https://core.openbox.ai').replace(/\/+$/, '');
    if (!envKey) {
        throw new n8n_workflow_1.NodeApiError(ctx.getNode(), {
            message: 'OpenBox API key not set',
            description: 'Attach an OpenBox credential to this node, or set OPENBOX_API_KEY in the environment.',
        });
    }
    return {
        openboxUrl: envUrl,
        apiKey: envKey,
        environment: 'production',
        timeoutMs: 35_000,
        failPolicy: 'fail_open',
        enforceHttps: false,
        agentDid: process.env.OPENBOX_AGENT_DID || undefined,
        agentPrivateKey: process.env.OPENBOX_AGENT_PRIVATE_KEY || undefined,
    };
}
/**
 * Make an authenticated request to the OpenBox Core API. Handles
 * scoping headers, timeout, and the `failPolicy` toggle. Errors
 * thrown from this helper are already shaped as NodeApiError so the
 * caller can re-throw without further wrapping.
 *
 * Note: we intentionally do NOT route through the OpenBoxCoreClient
 * here because the SDK client constructs its own retry/backoff and
 * doesn't accept the credentialed httpRequest helper. Going through
 * n8n's `helpers.httpRequest` keeps requests visible in the executions
 * UI and respects the credential's encrypted secrets.
 */
async function openboxRequest(ctx, options) {
    const credentials = await getOpenBoxCredentials(ctx);
    const url = `${credentials.openboxUrl}${options.path}`;
    // Serialize body before signing so the bytes we hash == the bytes we send.
    const bodyBytes = (0, signing_1.serializeBody)(options.body ?? null);
    const headers = (0, signing_1.buildSignedHeaders)(options.method, options.path, bodyBytes, credentials.apiKey, credentials.agentDid, credentials.agentPrivateKey);
    if (credentials.organizationId) {
        headers['X-OpenBox-Organization'] = credentials.organizationId;
    }
    if (credentials.projectId) {
        headers['X-OpenBox-Project'] = credentials.projectId;
    }
    if (options.traceId) {
        headers['X-OpenBox-Trace-Id'] = options.traceId;
    }
    // Always use json: false so we control the exact bytes on the wire.
    // n8n with json:true would re-serialize the body object, changing the bytes
    // and breaking the body-hash in the AIP signature. We parse the JSON response
    // ourselves after the call.
    const requestOptions = {
        method: options.method,
        url,
        headers,
        json: false,
        timeout: credentials.timeoutMs,
        body: bodyBytes.length > 0 ? bodyBytes : undefined,
        qs: options.qs,
        returnFullResponse: false,
        ignoreHttpStatusErrors: false,
    };
    try {
        const raw = await ctx.helpers.httpRequest(requestOptions);
        // n8n returns a string or Buffer when json: false — parse it ourselves.
        if (typeof raw === 'string')
            return JSON.parse(raw);
        if (Buffer.isBuffer(raw))
            return JSON.parse(raw.toString('utf-8'));
        return raw;
    }
    catch (err) {
        if (credentials.failPolicy === 'fail_open') {
            // Surface a structured "soft failure" so callers can decide
            // whether to keep going. We deliberately do NOT swallow the
            // error inside the helper itself; the caller knows whether the
            // operation was safe to skip.
            throw new SoftGovernanceError(err instanceof Error ? err.message : String(err), err);
        }
        throw new n8n_workflow_1.NodeApiError(ctx.getNode(), err, {
            message: `OpenBox API request failed: ${options.method} ${options.path}`,
        });
    }
}
/**
 * Marker error raised when `failPolicy === 'fail_open'` so callers can
 * distinguish a network/governance outage from a legitimate block
 * verdict. The original error is kept on `.cause` for diagnostics.
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
