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
