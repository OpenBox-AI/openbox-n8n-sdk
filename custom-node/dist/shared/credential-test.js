"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.testOpenBoxCredential = testOpenBoxCredential;
const OpenBoxApi_credentials_1 = require("../credentials/OpenBoxApi.credentials");
const signing_1 = require("./signing");
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
    const path = '/api/v1/auth/validate';
    const headers = (0, signing_1.buildSignedHeaders)('GET', path, Buffer.alloc(0), creds.apiKey, creds.agentDid, creds.agentPrivateKey);
    try {
        // n8n-workflow 1.x types don't declare httpRequest on ICredentialTestFunctions,
        // but the runtime exposes it (the linter rule explicitly requires it).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response = await this.helpers.httpRequest({
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
        return { status: 'OK', message: 'Connection successful' };
    }
    catch (err) {
        return {
            status: 'Error',
            message: `OpenBox credential test failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
