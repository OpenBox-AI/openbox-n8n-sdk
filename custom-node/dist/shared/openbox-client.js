"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SoftGovernanceError = void 0;
exports.getOpenBoxCredentials = getOpenBoxCredentials;
exports.openboxRequest = openboxRequest;
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
        // Credential not attached — fall through to env-var path
    }
    const envKey = process.env.OPENBOX_API_KEY ?? '';
    if (!envKey) {
        throw new n8n_workflow_1.NodeApiError(ctx.getNode(), {
            message: 'OpenBox API key not set',
            description: 'Attach an OpenBox credential to this node, or set OPENBOX_API_KEY in the environment.',
        });
    }
    return {
        openboxUrl: (process.env.OPENBOX_API_URL ?? 'https://core.openbox.ai').replace(/\/+$/, ''),
        apiKey: envKey,
        agentDid: process.env.OPENBOX_AGENT_DID || undefined,
        agentPrivateKey: process.env.OPENBOX_AGENT_PRIVATE_KEY || undefined,
    };
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
        timeout: OPENBOX_TIMEOUT_MS,
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
        throw new SoftGovernanceError(err instanceof Error ? err.message : String(err), err);
    }
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
