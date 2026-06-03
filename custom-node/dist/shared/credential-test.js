"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.testPostgresCredential = testPostgresCredential;
exports.testMysqlCredential = testMysqlCredential;
exports.testMongoDbCredential = testMongoDbCredential;
exports.testRedisCredential = testRedisCredential;
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
function findMysql2Promise() {
    try {
        const cache = require.cache;
        for (const [key, mod] of Object.entries(cache)) {
            if (/[/\\]mysql2[/\\]promise\.js$/.test(key) && mod?.exports) {
                const m = mod.exports;
                if (typeof m.createPool === 'function')
                    return m;
            }
        }
    }
    catch { /* best effort */ }
    return null;
}
async function testMysqlCredential(credential) {
    const mysql2 = findMysql2Promise();
    if (!mysql2) {
        return {
            status: 'Error',
            message: 'MySQL client not available — ensure the mysql2 package is installed in n8n.',
        };
    }
    const d = (credential.data ?? {});
    // Mirror n8n's SSL config building for MySQL credentials
    let ssl;
    if (d.ssl) {
        ssl = {};
        if (d.caCertificate)
            ssl.ca = String(d.caCertificate);
        if (d.clientCertificate)
            ssl.cert = String(d.clientCertificate);
        if (d.clientPrivateKey)
            ssl.key = String(d.clientPrivateKey);
    }
    const pool = mysql2.createPool({
        host: String(d.host ?? 'localhost'),
        port: Number(d.port ?? 3306),
        database: d.database ? String(d.database) : undefined,
        user: String(d.user ?? 'root'),
        password: String(d.password ?? ''),
        ssl,
        connectTimeout: 5000,
        connectionLimit: 1,
    });
    let connection = null;
    try {
        connection = await pool.getConnection();
        connection.release();
        return { status: 'OK', message: 'Connection successful' };
    }
    catch (err) {
        return {
            status: 'Error',
            message: `MySQL connection failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
    finally {
        try {
            await pool.end();
        }
        catch { /* ignore cleanup errors */ }
    }
}
function findMongoClient() {
    try {
        const cache = require.cache;
        for (const [key, mod] of Object.entries(cache)) {
            if (/[/\\]mongodb[/\\]lib[/\\]index\.js$/.test(key) && mod?.exports) {
                const m = mod.exports;
                if (typeof m.MongoClient === 'function')
                    return m.MongoClient;
            }
        }
    }
    catch { /* best effort */ }
    return null;
}
function buildMongoConnectionString(d) {
    if (d.configurationType === 'connectionString') {
        return String(d.connectionString ?? '');
    }
    const user = d.user ? encodeURIComponent(String(d.user)) : '';
    const password = d.password ? encodeURIComponent(String(d.password)) : '';
    const credentials = user ? `${user}:${password}@` : '';
    const host = String(d.host ?? 'localhost');
    const database = d.database ? `/${encodeURIComponent(String(d.database))}` : '';
    if (d.port) {
        return `mongodb://${credentials}${host}:${Number(d.port)}${database}`;
    }
    return `mongodb+srv://${credentials}${host}${database}`;
}
async function testMongoDbCredential(credential) {
    const MongoClient = findMongoClient();
    if (!MongoClient) {
        return {
            status: 'Error',
            message: 'MongoDB client not available — ensure the mongodb package is installed in n8n.',
        };
    }
    const d = (credential.data ?? {});
    const uri = buildMongoConnectionString(d);
    if (!uri) {
        return { status: 'Error', message: 'MongoDB connection string is empty.' };
    }
    const tlsOptions = {};
    if (d.tls) {
        tlsOptions.tls = true;
        if (d.ca)
            tlsOptions.tlsCAFile = String(d.ca);
        if (d.cert)
            tlsOptions.tlsCertificateFile = String(d.cert);
        if (d.key)
            tlsOptions.tlsCertificateKeyFile = String(d.key);
        if (d.passphrase)
            tlsOptions.tlsCertificateKeyFilePassword = String(d.passphrase);
    }
    const client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
        ...tlsOptions,
    });
    try {
        await client.connect();
        return { status: 'OK', message: 'Connection successful' };
    }
    catch (err) {
        return {
            status: 'Error',
            message: `MongoDB connection failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
    finally {
        try {
            await client.close();
        }
        catch { /* ignore cleanup errors */ }
    }
}
function findRedisModule() {
    try {
        const cache = require.cache;
        for (const [key, mod] of Object.entries(cache)) {
            // redis package ships dist/index.js or build/lib/index.js depending on version
            if (/[/\\]redis[/\\](dist|build[/\\]lib)[/\\]index\.js$/.test(key) && mod?.exports) {
                const m = mod.exports;
                if (typeof m.createClient === 'function')
                    return m;
            }
        }
    }
    catch { /* best effort */ }
    return null;
}
async function testRedisCredential(credential) {
    const redis = findRedisModule();
    if (!redis) {
        return {
            status: 'Error',
            message: 'Redis client not available — ensure the redis package is installed in n8n.',
        };
    }
    const d = (credential.data ?? {});
    const tlsEnabled = Boolean(d.ssl);
    const tlsOptions = tlsEnabled
        ? { rejectUnauthorized: d.disableTlsVerification !== true }
        : undefined;
    const client = redis.createClient({
        socket: {
            host: String(d.host ?? 'localhost'),
            port: Number(d.port ?? 6379),
            tls: tlsEnabled,
            ...(tlsOptions ? { tls: tlsOptions } : {}),
            connectTimeout: 10000,
            // Prevent automatic reconnect during a credential test
            reconnectStrategy: false,
        },
        database: d.database !== undefined && d.database !== '' ? Number(d.database) : undefined,
        username: d.user ? String(d.user) : undefined,
        password: d.password ? String(d.password) : undefined,
    });
    // Capture connection-level errors (emitted before connect() rejects)
    let connectionError = null;
    client.on('error', (err) => {
        connectionError = err;
    });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timed out after 10s')), 10000));
    try {
        await Promise.race([client.connect(), timeout]);
        if (connectionError)
            throw connectionError;
        await client.ping();
        return { status: 'OK', message: 'Connection successful' };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err.code;
        if (code === 'ECONNRESET') {
            return {
                status: 'Error',
                message: `Redis connection failed: SSL/TLS connection was forcibly closed — check if SSL is required or disable "SSL" in credentials.`,
            };
        }
        if (code === 'ECONNREFUSED') {
            return {
                status: 'Error',
                message: `Redis connection failed: Connection refused at ${String(d.host ?? 'localhost')}:${String(d.port ?? 6379)} — verify host, port, and that Redis is running.`,
            };
        }
        return {
            status: 'Error',
            message: `Redis connection failed: ${message}`,
        };
    }
    finally {
        try {
            await client.quit();
        }
        catch { /* ignore */ }
        try {
            client.disconnect();
        }
        catch { /* ignore */ }
    }
}
// ── OpenBox ───────────────────────────────────────────────────────────────────
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
