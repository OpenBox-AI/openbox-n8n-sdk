"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.testPostgresCredential = testPostgresCredential;
exports.testOpenBoxCredential = testOpenBoxCredential;
const OpenBoxApi_credentials_1 = require("../credentials/OpenBoxApi.credentials");
const signing_1 = require("./signing");
/** Find pg.Client from n8n's require cache — mirrors node_instrumentation.ts. */
function findPgClient() {
    try {
        const cache = require.cache;
        for (const [key, mod] of Object.entries(cache)) {
            if (/[/\\]pg[/\\]lib[/\\]index\.js$/.test(key) && mod?.exports) {
                const c = mod.exports.Client;
                if (typeof c === 'function')
                    return c;
            }
        }
    }
    catch { /* best effort */ }
    return null;
}
/**
 * Credential test for n8n's built-in `postgres` credential type.
 * n8n-nodes-base does not ship a test for postgres credentials, so this
 * function fills the gap. Register it under `methods.credentialTest` in any
 * node that accepts a postgres credential with `testedBy: 'postgresConnectionTest'`.
 */
async function testPostgresCredential(credential) {
    const PgClient = findPgClient();
    if (!PgClient) {
        return {
            status: 'Error',
            message: 'Postgres client not available — ensure the pg package is installed in n8n.',
        };
    }
    const d = (credential.data ?? {});
    const sslMode = String(d.ssl ?? 'disable');
    const ssl = sslMode === 'disable'
        ? false
        : { rejectUnauthorized: d.allowUnauthorizedCerts !== true };
    const client = new PgClient({
        host: String(d.host ?? 'localhost'),
        port: Number(d.port ?? 5432),
        database: String(d.database ?? 'postgres'),
        user: String(d.user ?? 'postgres'),
        password: String(d.password ?? ''),
        ssl,
        connectionTimeoutMillis: 5000,
    });
    try {
        await client.connect();
        await client.end();
        return { status: 'OK', message: 'Connection successful' };
    }
    catch (err) {
        return {
            status: 'Error',
            message: `Postgres connection failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
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
        await this.helpers.request({
            method: 'GET',
            url: `${creds.openboxUrl}${path}`,
            headers,
            json: true,
        });
        return { status: 'OK', message: 'Connection successful' };
    }
    catch (err) {
        return {
            status: 'Error',
            message: `OpenBox credential test failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
