import type {
  ICredentialTestFunctions,
  ICredentialsDecrypted,
  INodeCredentialTestResult,
} from 'n8n-workflow';

import { normalizeOpenBoxCredentials } from '../credentials/OpenBoxApi.credentials';
import { buildSignedHeaders } from './signing';

// ── Postgres ─────────────────────────────────────────────────────────────────

type PgClientCtor = new (config: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean | { rejectUnauthorized: boolean };
  connectionTimeoutMillis: number;
}) => { connect(): Promise<void>; end(): Promise<void> };

/** Find pg.Client from n8n's require cache — mirrors node_instrumentation.ts. */
function findPgClient(): PgClientCtor | null {
  try {
    const cache = (require as unknown as { cache: Record<string, { exports: unknown }> }).cache;
    for (const [key, mod] of Object.entries(cache)) {
      if (/[/\\]pg[/\\]lib[/\\]index\.js$/.test(key) && mod?.exports) {
        const c = (mod.exports as { Client?: unknown }).Client;
        if (typeof c === 'function') return c as PgClientCtor;
      }
    }
  } catch { /* best effort */ }
  return null;
}

/**
 * Credential test for n8n's built-in `postgres` credential type.
 * n8n-nodes-base does not ship a test for postgres credentials, so this
 * function fills the gap. Register it under `methods.credentialTest` in any
 * node that accepts a postgres credential with `testedBy: 'postgresConnectionTest'`.
 */
export async function testPostgresCredential(
  this: ICredentialTestFunctions,
  credential: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
  const PgClient = findPgClient();
  if (!PgClient) {
    return {
      status: 'Error',
      message: 'Postgres client not available — ensure the pg package is installed in n8n.',
    };
  }

  const d = (credential.data ?? {}) as Record<string, unknown>;
  const sslMode = String(d.ssl ?? 'disable');
  const ssl: boolean | { rejectUnauthorized: boolean } =
    sslMode === 'disable'
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
  } catch (err) {
    return {
      status: 'Error',
      message: `Postgres connection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── MySQL ─────────────────────────────────────────────────────────────────────

type Mysql2Pool = {
  getConnection(): Promise<{ release(): void }>;
  end(): Promise<void>;
};

type Mysql2Promise = {
  createPool(config: Record<string, unknown>): Mysql2Pool;
};

function findMysql2Promise(): Mysql2Promise | null {
  try {
    const cache = (require as unknown as { cache: Record<string, { exports: unknown }> }).cache;
    for (const [key, mod] of Object.entries(cache)) {
      if (/[/\\]mysql2[/\\]promise\.js$/.test(key) && mod?.exports) {
        const m = mod.exports as { createPool?: unknown };
        if (typeof m.createPool === 'function') return m as Mysql2Promise;
      }
    }
  } catch { /* best effort */ }
  return null;
}

export async function testMysqlCredential(
  this: ICredentialTestFunctions,
  credential: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
  const mysql2 = findMysql2Promise();
  if (!mysql2) {
    return {
      status: 'Error',
      message: 'MySQL client not available — ensure the mysql2 package is installed in n8n.',
    };
  }

  const d = (credential.data ?? {}) as Record<string, unknown>;

  // Mirror n8n's SSL config building for MySQL credentials
  let ssl: Record<string, unknown> | undefined;
  if (d.ssl) {
    ssl = {};
    if (d.caCertificate) ssl.ca = String(d.caCertificate);
    if (d.clientCertificate) ssl.cert = String(d.clientCertificate);
    if (d.clientPrivateKey) ssl.key = String(d.clientPrivateKey);
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

  let connection: { release(): void } | null = null;
  try {
    connection = await pool.getConnection();
    connection.release();
    return { status: 'OK', message: 'Connection successful' };
  } catch (err) {
    return {
      status: 'Error',
      message: `MySQL connection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    try { await pool.end(); } catch { /* ignore cleanup errors */ }
  }
}

// ── MongoDB ───────────────────────────────────────────────────────────────────

type MongoClientCtor = new (
  uri: string,
  options?: Record<string, unknown>,
) => { connect(): Promise<void>; close(): Promise<void> };

function findMongoClient(): MongoClientCtor | null {
  try {
    const cache = (require as unknown as { cache: Record<string, { exports: unknown }> }).cache;
    for (const [key, mod] of Object.entries(cache)) {
      if (/[/\\]mongodb[/\\]lib[/\\]index\.js$/.test(key) && mod?.exports) {
        const m = mod.exports as { MongoClient?: unknown };
        if (typeof m.MongoClient === 'function') return m.MongoClient as MongoClientCtor;
      }
    }
  } catch { /* best effort */ }
  return null;
}

function buildMongoConnectionString(d: Record<string, unknown>): string {
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

export async function testMongoDbCredential(
  this: ICredentialTestFunctions,
  credential: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
  const MongoClient = findMongoClient();
  if (!MongoClient) {
    return {
      status: 'Error',
      message: 'MongoDB client not available — ensure the mongodb package is installed in n8n.',
    };
  }

  const d = (credential.data ?? {}) as Record<string, unknown>;
  const uri = buildMongoConnectionString(d);
  if (!uri) {
    return { status: 'Error', message: 'MongoDB connection string is empty.' };
  }

  const tlsOptions: Record<string, unknown> = {};
  if (d.tls) {
    tlsOptions.tls = true;
    if (d.ca) tlsOptions.tlsCAFile = String(d.ca);
    if (d.cert) tlsOptions.tlsCertificateFile = String(d.cert);
    if (d.key) tlsOptions.tlsCertificateKeyFile = String(d.key);
    if (d.passphrase) tlsOptions.tlsCertificateKeyFilePassword = String(d.passphrase);
  }

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    ...tlsOptions,
  });

  try {
    await client.connect();
    return { status: 'OK', message: 'Connection successful' };
  } catch (err) {
    return {
      status: 'Error',
      message: `MongoDB connection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    try { await client.close(); } catch { /* ignore cleanup errors */ }
  }
}

// ── Redis ─────────────────────────────────────────────────────────────────────

type RedisClient = {
  connect(): Promise<void>;
  ping(): Promise<string>;
  quit(): Promise<void>;
  disconnect(): void;
  on(event: string, handler: (err: Error) => void): RedisClient;
};

type RedisModule = {
  createClient(config: Record<string, unknown>): RedisClient;
};

function findRedisModule(): RedisModule | null {
  try {
    const cache = (require as unknown as { cache: Record<string, { exports: unknown }> }).cache;
    for (const [key, mod] of Object.entries(cache)) {
      // redis package ships dist/index.js or build/lib/index.js depending on version
      if (/[/\\]redis[/\\](dist|build[/\\]lib)[/\\]index\.js$/.test(key) && mod?.exports) {
        const m = mod.exports as { createClient?: unknown };
        if (typeof m.createClient === 'function') return m as RedisModule;
      }
    }
  } catch { /* best effort */ }
  return null;
}

export async function testRedisCredential(
  this: ICredentialTestFunctions,
  credential: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
  const redis = findRedisModule();
  if (!redis) {
    return {
      status: 'Error',
      message: 'Redis client not available — ensure the redis package is installed in n8n.',
    };
  }

  const d = (credential.data ?? {}) as Record<string, unknown>;

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
  let connectionError: Error | null = null;
  client.on('error', (err: Error) => {
    connectionError = err;
  });

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Connection timed out after 10s')), 10000),
  );

  try {
    await Promise.race([client.connect(), timeout]);
    if (connectionError) throw connectionError;
    await client.ping();
    return { status: 'OK', message: 'Connection successful' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as NodeJS.ErrnoException).code;

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
  } finally {
    try { await client.quit(); } catch { /* ignore */ }
    try { client.disconnect(); } catch { /* ignore */ }
  }
}

// ── SearXng ───────────────────────────────────────────────────────────────────

/**
 * Credential test for SearXng (`searXngApi`). The official credential class
 * ships no built-in test. We hit `/search?q=test&format=json` with a short
 * timeout — a 200 or 400 both confirm the server is reachable; only a network
 * error or non-JSON host page counts as failure.
 */
export async function testSearXngCredential(
  this: ICredentialTestFunctions,
  credential: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
  const d = (credential.data ?? {}) as Record<string, unknown>;
  const baseUrl = String(d.apiUrl ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    return { status: 'Error', message: 'SearXng API URL is empty.' };
  }

  try {
    await this.helpers.request({
      method: 'GET',
      url: `${baseUrl}/search`,
      qs: { q: 'test', format: 'json' },
      json: true,
      timeout: 8000,
    });
    return { status: 'OK', message: 'Connection successful' };
  } catch (err: unknown) {
    // A 400 (bad request) still means the SearXng server responded — treat as OK.
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode !== undefined && statusCode < 500) {
      return { status: 'OK', message: 'Connection successful' };
    }
    return {
      status: 'Error',
      message: `SearXng connection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── OpenBox ───────────────────────────────────────────────────────────────────

/**
 * Shared implementation for testing an OpenBox credential. Call this from every
 * node's `methods.credentialTest.openBoxApiCredentialTest` method so the logic
 * stays in one place.
 */
export async function testOpenBoxCredential(
  this: ICredentialTestFunctions,
  credential: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
  let creds;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    creds = normalizeOpenBoxCredentials(credential.data as any);
  } catch (err) {
    return { status: 'Error', message: (err as Error).message };
  }

  const path = '/api/v1/auth/validate';
  const headers = buildSignedHeaders(
    'GET',
    path,
    Buffer.alloc(0),
    creds.apiKey,
    creds.agentDid,
    creds.agentPrivateKey,
  );

  try {
    await this.helpers.request({
      method: 'GET',
      url: `${creds.openboxUrl}${path}`,
      headers,
      json: true,
    });
    return { status: 'OK', message: 'Connection successful' };
  } catch (err: unknown) {
    return {
      status: 'Error',
      message: `OpenBox credential test failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
