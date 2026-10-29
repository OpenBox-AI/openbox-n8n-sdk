"use strict";
/* eslint-disable @n8n/community-nodes/require-node-api-error */
/**
 * v3 Keycloak workload identity — a port of openbox-sdk-python's
 * `workload_identity.py` and the workload half of its `EvaluationClient`.
 *
 * Flow, per credential:
 *   1. `GET /api/v3/auth/bootstrap` (API key) → the agent's Keycloak authority.
 *   2. RS256 private-key JWT signed with the workload key → Keycloak token
 *      endpoint (`client_credentials`) → a short-lived access token.
 *   3. Every governance request carries the API key in `Authorization` and the
 *      token in `X-OpenBox-Workload-Token`, on the `/api/v3/*` paths.
 *
 * A bootstrap 404 (or 409 `workload_identity_unavailable`) means Core has no v3
 * authority for this agent: callers fall back to the legacy v1 path and the
 * bootstrap is retried after a minute. Every other failure is reported, never
 * silently downgraded. n8n rebuilds the node on every execution, so the token
 * cache lives at module level, keyed by the credential.
 *
 * Uses only Node's `crypto` — community nodes cannot carry runtime dependencies.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkloadIdentityError = exports.CLIENT_ASSERTION_TYPE = exports.WORKLOAD_TOKEN_HEADER = exports.AUTH_BOOTSTRAP_PATH_V3 = void 0;
exports.parseWorkloadBootstrapDocument = parseWorkloadBootstrapDocument;
exports.parseWorkloadBootstrapResponse = parseWorkloadBootstrapResponse;
exports.parseWorkloadTokenResponse = parseWorkloadTokenResponse;
exports.normalizePrivateKeyPem = normalizePrivateKeyPem;
exports.loadWorkloadPrivateKey = loadWorkloadPrivateKey;
exports.buildClientAssertion = buildClientAssertion;
exports.getWorkloadAuth = getWorkloadAuth;
exports.invalidateWorkloadToken = invalidateWorkloadToken;
exports.resetWorkloadCache = resetWorkloadCache;
const crypto_1 = require("crypto");
exports.AUTH_BOOTSTRAP_PATH_V3 = '/api/v3/auth/bootstrap';
exports.WORKLOAD_TOKEN_HEADER = 'X-OpenBox-Workload-Token';
exports.CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const SUPPORTED_BOOTSTRAP_VERSION = 3;
const SUPPORTED_CONTRACT_VERSION = 3;
const CLIENT_ASSERTION_LIFETIME_SECONDS = 60;
const ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 30;
const MAX_ACCESS_TOKEN_CACHE_SECONDS = 300;
const UNAVAILABLE_RETRY_MS = 60_000;
const SUPPORTED_IDENTITY_SOURCES = new Set(['openbox', 'okta', 'entra']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class WorkloadIdentityError extends Error {
    kind;
    statusCode;
    constructor(kind, message, statusCode) {
        super(message);
        this.name = 'WorkloadIdentityError';
        this.kind = kind;
        this.statusCode = statusCode;
    }
}
exports.WorkloadIdentityError = WorkloadIdentityError;
// ── Validation ────────────────────────────────────────────────────────────────
function requireString(source, field) {
    const value = source[field];
    if (typeof value !== 'string' || !value.trim()) {
        throw new WorkloadIdentityError('config', `Workload bootstrap response is invalid: '${field}' must be a non-empty string.`);
    }
    return value.trim();
}
function requireUuid(source, field) {
    const value = requireString(source, field);
    if (!UUID_RE.test(value)) {
        throw new WorkloadIdentityError('config', `Workload bootstrap response is invalid: '${field}' must be a canonical UUID.`);
    }
    return value;
}
function validateEndpointPair(issuer, tokenEndpoint) {
    for (const [name, raw] of [['issuer', issuer], ['token_endpoint', tokenEndpoint]]) {
        let parsed;
        try {
            parsed = new URL(raw);
        }
        catch {
            throw new WorkloadIdentityError('config', `Workload bootstrap response is invalid: '${name}' must be an absolute URL.`);
        }
        if (!parsed.hostname || parsed.username || parsed.password) {
            throw new WorkloadIdentityError('config', `Workload bootstrap response is invalid: '${name}' must be an absolute URL.`);
        }
        const isLocal = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
        if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
            throw new WorkloadIdentityError('config', `Workload bootstrap response is invalid: '${name}' must use HTTPS.`);
        }
        if (parsed.search || parsed.hash) {
            throw new WorkloadIdentityError('config', `Workload bootstrap response is invalid: '${name}' cannot contain query or fragment data.`);
        }
    }
    if (tokenEndpoint !== `${issuer.replace(/\/+$/, '')}/protocol/openid-connect/token`) {
        throw new WorkloadIdentityError('config', "Workload bootstrap response is invalid: 'token_endpoint' must belong to the exact advertised issuer.");
    }
}
/** Strictly validate Core's v3 workload bootstrap document. */
function parseWorkloadBootstrapDocument(raw) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new WorkloadIdentityError('config', 'Workload bootstrap response is invalid: expected a JSON object.');
    }
    const doc = raw;
    if (doc.bootstrap_version !== SUPPORTED_BOOTSTRAP_VERSION) {
        throw new WorkloadIdentityError('config', 'Unsupported workload bootstrap version; upgrade the OpenBox node to match the Core deployment.');
    }
    if (doc.contract_version !== SUPPORTED_CONTRACT_VERSION) {
        throw new WorkloadIdentityError('config', 'Unsupported workload contract version; upgrade the OpenBox node to match the Core deployment.');
    }
    const issuer = requireString(doc, 'issuer').replace(/\/+$/, '');
    const tokenEndpoint = requireString(doc, 'token_endpoint');
    validateEndpointPair(issuer, tokenEndpoint);
    const identitySource = requireString(doc, 'identity_source').toLowerCase();
    if (!SUPPORTED_IDENTITY_SOURCES.has(identitySource)) {
        throw new WorkloadIdentityError('config', "Workload bootstrap response is invalid: 'identity_source' is unsupported.");
    }
    return {
        tokenEndpoint,
        issuer,
        audience: requireString(doc, 'audience'),
        clientId: requireString(doc, 'client_id'),
        serviceAccountId: requireUuid(doc, 'service_account_id'),
        activationVersion: requireUuid(doc, 'activation_version'),
        identitySource,
        kid: requireString(doc, 'kid'),
    };
}
function reasonCode(body) {
    try {
        const payload = JSON.parse(body);
        const value = payload?.reason_code ?? payload?.code;
        return typeof value === 'string' ? value : null;
    }
    catch {
        return null;
    }
}
/**
 * Parse the bootstrap response, or `null` only when Core explicitly has no v3
 * authority for this agent (404, or 409 `workload_identity_unavailable`).
 */
function parseWorkloadBootstrapResponse(status, body) {
    if (status === 404)
        return null;
    if (status === 409 && reasonCode(body) === 'workload_identity_unavailable')
        return null;
    if (status === 401 || status === 403) {
        throw new WorkloadIdentityError('auth', `Workload identity bootstrap was rejected (HTTP ${status}).`, status);
    }
    if (status !== 200) {
        throw new WorkloadIdentityError('network', `OpenBox workload identity bootstrap failed (HTTP ${status}).`, status);
    }
    let payload;
    try {
        payload = JSON.parse(body);
    }
    catch {
        throw new WorkloadIdentityError('config', 'Workload bootstrap response is invalid: expected JSON.');
    }
    return parseWorkloadBootstrapDocument(payload);
}
/** A validated token-endpoint response: the token and how long it may be cached. */
function parseWorkloadTokenResponse(status, body) {
    if (status === 400 || status === 401 || status === 403) {
        throw new WorkloadIdentityError('auth', `Keycloak workload token exchange was rejected (HTTP ${status}).`, status);
    }
    if (status !== 200) {
        throw new WorkloadIdentityError('network', `Keycloak workload token exchange failed (HTTP ${status}).`, status);
    }
    let payload;
    try {
        payload = JSON.parse(body);
    }
    catch {
        throw new WorkloadIdentityError('config', 'Keycloak workload token response is invalid: expected JSON.');
    }
    if (payload == null || typeof payload !== 'object') {
        throw new WorkloadIdentityError('config', 'Keycloak workload token response is invalid: expected an object.');
    }
    const accessToken = payload.access_token;
    const tokenType = payload.token_type;
    const expiresIn = payload.expires_in;
    if (typeof accessToken !== 'string' || !accessToken) {
        throw new WorkloadIdentityError('config', "Keycloak workload token response is invalid: 'access_token' is required.");
    }
    if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') {
        throw new WorkloadIdentityError('config', 'Keycloak workload token response is invalid: token_type must be Bearer.');
    }
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= ACCESS_TOKEN_REFRESH_SKEW_SECONDS) {
        throw new WorkloadIdentityError('config', 'Keycloak workload token response is invalid: expires_in is too short.');
    }
    return { accessToken, cacheSeconds: Math.min(expiresIn, MAX_ACCESS_TOKEN_CACHE_SECONDS) };
}
// ── Private-key JWT ───────────────────────────────────────────────────────────
/**
 * Accept the key as pasted into an n8n field: literal `\n` sequences (a PEM
 * copied from an env file) become real line breaks.
 */
function normalizePrivateKeyPem(raw) {
    return raw.trim().replace(/\\n/g, '\n');
}
/** Load the workload key; it must be an RSA private key. */
function loadWorkloadPrivateKey(pem) {
    let key;
    try {
        key = (0, crypto_1.createPrivateKey)({ key: normalizePrivateKeyPem(pem), format: 'pem' });
    }
    catch {
        throw new WorkloadIdentityError('config', 'The Workload Private Key is not a valid PEM private key.');
    }
    if (key.asymmetricKeyType !== 'rsa') {
        throw new WorkloadIdentityError('config', 'The Workload Private Key must be an RSA private key.');
    }
    return key;
}
function b64url(value) {
    return value.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
/** JSON with sorted keys and no spaces — the form the Python SDK signs. */
function canonicalJson(value) {
    const sorted = {};
    for (const k of Object.keys(value).sort())
        sorted[k] = value[k];
    return Buffer.from(JSON.stringify(sorted), 'utf-8');
}
/** RFC 7523 client assertion for the Keycloak token exchange (RS256). */
function buildClientAssertion(key, document, issuedAt = Math.floor(Date.now() / 1000), jti = b64url((0, crypto_1.randomBytes)(24))) {
    const header = { alg: 'RS256', kid: document.kid, typ: 'JWT' };
    const claims = {
        aud: document.tokenEndpoint,
        exp: issuedAt + CLIENT_ASSERTION_LIFETIME_SECONDS,
        iat: issuedAt,
        iss: document.clientId,
        jti,
        sub: document.clientId,
    };
    const signingInput = `${b64url(canonicalJson(header))}.${b64url(canonicalJson(claims))}`;
    const signature = (0, crypto_1.sign)('sha256', Buffer.from(signingInput, 'ascii'), key);
    return `${signingInput}.${b64url(signature)}`;
}
const _cache = new Map();
function cacheKey(apiUrl, apiKey, privateKeyPem) {
    return (0, crypto_1.createHash)('sha256').update(`${apiUrl}\0${apiKey}\0${normalizePrivateKeyPem(privateKeyPem)}`).digest('hex');
}
async function acquire(http, cred, entry, onAuthority) {
    // Fail locally before any authority metadata is requested.
    const key = loadWorkloadPrivateKey(cred.privateKeyPem);
    let document = entry.document;
    if (document == null) {
        let response;
        try {
            response = await http({
                method: 'GET',
                url: `${cred.apiUrl}${exports.AUTH_BOOTSTRAP_PATH_V3}`,
                headers: { ...cred.coreHeaders, Accept: 'application/json' },
            });
        }
        catch (err) {
            throw new WorkloadIdentityError('network', `OpenBox workload identity bootstrap is unavailable (${err instanceof Error ? err.message : String(err)}).`);
        }
        document = parseWorkloadBootstrapResponse(response.status, response.body);
        if (document == null) {
            entry.unavailableUntil = Date.now() + UNAVAILABLE_RETRY_MS;
            return null;
        }
        // Before the token exchange: the Keycloak call must never be captured as
        // a hook span of whatever activity happens to be running.
        onAuthority(document);
    }
    const body = new URLSearchParams([
        ['grant_type', 'client_credentials'],
        ['client_id', document.clientId],
        ['client_assertion_type', exports.CLIENT_ASSERTION_TYPE],
        ['client_assertion', buildClientAssertion(key, document)],
    ]).toString();
    const startedAt = Date.now();
    let response;
    try {
        response = await http({
            method: 'POST',
            url: document.tokenEndpoint,
            headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
    }
    catch (err) {
        throw new WorkloadIdentityError('network', `Keycloak workload token exchange is unavailable (${err instanceof Error ? err.message : String(err)}).`);
    }
    const token = parseWorkloadTokenResponse(response.status, response.body);
    // Authority and token are published together, so no caller ever sees one
    // without the other.
    entry.document = document;
    entry.token = token.accessToken;
    entry.refreshAt = startedAt + (token.cacheSeconds - ACCESS_TOKEN_REFRESH_SKEW_SECONDS) * 1000;
    entry.unavailableUntil = 0;
    return { token: token.accessToken, document };
}
/**
 * The workload token for this credential, acquiring or renewing it when
 * needed. `null` when Core has no v3 authority for the agent (legacy path).
 * Concurrent callers share one acquisition.
 */
async function getWorkloadAuth(http, cred, onAuthority = () => undefined) {
    const k = cacheKey(cred.apiUrl, cred.apiKey, cred.privateKeyPem);
    let entry = _cache.get(k);
    if (!entry) {
        entry = { document: null, token: null, refreshAt: 0, unavailableUntil: 0, inflight: null };
        _cache.set(k, entry);
    }
    if (entry.token != null && entry.document != null && Date.now() < entry.refreshAt) {
        return { token: entry.token, document: entry.document };
    }
    if (entry.document == null && Date.now() < entry.unavailableUntil)
        return null;
    if (entry.inflight)
        return entry.inflight;
    const current = entry;
    current.inflight = acquire(http, cred, current, onAuthority).finally(() => {
        current.inflight = null;
    });
    return current.inflight;
}
/**
 * Core rejected a request carrying `token`: discard it (never a newer one) so
 * the next operation bootstraps again. The rejected request is not replayed.
 */
function invalidateWorkloadToken(cred, token) {
    const entry = _cache.get(cacheKey(cred.apiUrl, cred.apiKey, cred.privateKeyPem));
    if (entry && entry.token === token) {
        entry.token = null;
        entry.document = null;
        entry.refreshAt = 0;
    }
}
/** Test seam: forget every cached authority and token. */
function resetWorkloadCache() {
    _cache.clear();
}
