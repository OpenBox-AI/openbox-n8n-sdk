"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.testOpenBoxCredential = testOpenBoxCredential;
const OpenBoxApi_credentials_1 = require("../credentials/OpenBoxApi.credentials");
const openbox_client_1 = require("./openbox-client");
const signing_1 = require("./signing");
const workload_identity_1 = require("./workload-identity");
const CREDENTIAL_TEST_TIMEOUT_MS = 30_000;
/**
 * Shared implementation for testing an OpenBox credential. Call this from every
 * node's `methods.credentialTest.openBoxApiCredentialTest` method so the logic
 * stays in one place.
 */
async function testOpenBoxCredential(credential) {
    let creds;
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        creds = (0, OpenBoxApi_credentials_1.normalizeOpenBoxCredentials)(credential.data);
    }
    catch (err) {
        return { status: 'Error', message: err.message };
    }
    // n8n-workflow 1.x types don't declare httpRequest on ICredentialTestFunctions,
    // but the runtime exposes it (the linter rule explicitly requires it).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const helpers = this.helpers;
    // With a workload key, the test proves the whole v3 chain: bootstrap, the
    // Keycloak token exchange, and Core accepting the token.
    let path = '/api/v1/auth/validate';
    let headers;
    let workloadToken = null;
    if (creds.workloadPrivateKey) {
        try {
            const auth = await (0, workload_identity_1.getWorkloadAuth)((0, openbox_client_1.workloadHttpFor)(helpers, CREDENTIAL_TEST_TIMEOUT_MS), {
                apiUrl: creds.openboxUrl,
                apiKey: creds.apiKey,
                privateKeyPem: creds.workloadPrivateKey,
                coreHeaders: (0, signing_1.buildSignedHeaders)('GET', '/api/v3/auth/bootstrap', Buffer.alloc(0), creds.apiKey),
            });
            if (auth) {
                workloadToken = auth.token;
                path = '/api/v3/auth/validate';
            }
        }
        catch (err) {
            const message = err instanceof workload_identity_1.WorkloadIdentityError ? err.message : String(err);
            return { status: 'Error', message: `OpenBox workload identity failed: ${message}` };
        }
    }
    if (workloadToken != null) {
        headers = { ...(0, signing_1.buildSignedHeaders)('GET', path, Buffer.alloc(0), creds.apiKey), [workload_identity_1.WORKLOAD_TOKEN_HEADER]: workloadToken };
    }
    else {
        headers = (0, signing_1.buildSignedHeaders)('GET', path, Buffer.alloc(0), creds.apiKey, creds.agentDid, creds.agentPrivateKey);
    }
    try {
        const response = await helpers.httpRequest({
            method: 'GET',
            url: `${creds.openboxUrl}${path}`,
            headers,
            json: true,
        });
        // Best-effort response-shape check — Core's exact schema for this endpoint
        // isn't documented, so only an explicit `valid: false` is treated as a
        // failure; anything else that didn't throw is accepted as success.
        if (response && typeof response === 'object' && 'valid' in response && !response.valid) {
            return { status: 'Error', message: 'OpenBox credential test failed: Core reported the credential as invalid' };
        }
        return {
            status: 'OK',
            message: workloadToken != null ? 'Connection successful (v3 workload identity)' : 'Connection successful',
        };
    }
    catch (err) {
        return {
            status: 'Error',
            message: `OpenBox credential test failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
