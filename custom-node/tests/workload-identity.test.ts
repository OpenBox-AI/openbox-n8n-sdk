import { generateKeyPairSync, verify } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openboxRequest, GovernanceAuthError, SoftGovernanceError } from '../shared/openbox-client';
import { SDK_IDENTITY } from '../shared/signing';
import { shouldIgnore } from '../shared/ignored-urls';
import {
  CLIENT_ASSERTION_TYPE,
  WorkloadHttp,
  WorkloadIdentityError,
  buildClientAssertion,
  getWorkloadAuth,
  invalidateWorkloadToken,
  loadWorkloadPrivateKey,
  parseWorkloadBootstrapResponse,
  parseWorkloadTokenResponse,
  resetWorkloadCache,
} from '../shared/workload-identity';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const ISSUER = 'https://auth.openbox.example/realms/agents';
const BOOTSTRAP = {
  bootstrap_version: 3,
  contract_version: 3,
  issuer: ISSUER,
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
  audience: 'openbox-core',
  client_id: 'agent-client',
  service_account_id: '11111111-2222-4333-8444-555555555555',
  activation_version: '66666666-7777-4888-8999-aaaaaaaaaaaa',
  identity_source: 'openbox',
  kid: 'key-1',
};
const API_URL = 'https://core.example.test';
const CRED = { apiUrl: API_URL, apiKey: 'obx_live_test', privateKeyPem: PEM, coreHeaders: { Authorization: 'Bearer obx_live_test' } };

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf-8')) as Record<string, unknown>;
}

/** Fake Core + Keycloak. */
function fakeAuthority(opts: { bootstrapStatus?: number; tokenStatus?: number } = {}) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: string }> = [];
  const http: WorkloadHttp = async (request) => {
    calls.push(request);
    if (request.url.endsWith('/api/v3/auth/bootstrap')) {
      const status = opts.bootstrapStatus ?? 200;
      return { status, body: status === 200 ? JSON.stringify(BOOTSTRAP) : '{}' };
    }
    if (request.url === BOOTSTRAP.token_endpoint) {
      const status = opts.tokenStatus ?? 200;
      return {
        status,
        body: JSON.stringify({ access_token: `token-${calls.length}`, token_type: 'Bearer', expires_in: 300 }),
      };
    }
    return { status: 500, body: '' };
  };
  return { calls, http };
}

afterEach(() => {
  resetWorkloadCache();
});

describe('workload bootstrap and token parsing', () => {
  it('accepts a valid bootstrap document', () => {
    const doc = parseWorkloadBootstrapResponse(200, JSON.stringify(BOOTSTRAP));
    expect(doc).toMatchObject({ clientId: 'agent-client', kid: 'key-1', tokenEndpoint: BOOTSTRAP.token_endpoint });
  });

  it('treats 404 and 409 workload_identity_unavailable as "no v3 authority"', () => {
    expect(parseWorkloadBootstrapResponse(404, '')).toBeNull();
    expect(parseWorkloadBootstrapResponse(409, JSON.stringify({ reason_code: 'workload_identity_unavailable' }))).toBeNull();
  });

  it('fails closed on a rejected bootstrap and reports other failures', () => {
    expect(() => parseWorkloadBootstrapResponse(401, '')).toThrow(expect.objectContaining({ kind: 'auth' }));
    expect(() => parseWorkloadBootstrapResponse(503, '')).toThrow(expect.objectContaining({ kind: 'network' }));
    expect(() => parseWorkloadBootstrapResponse(409, '{}')).toThrow(WorkloadIdentityError);
  });

  it('rejects an unsupported version or a token endpoint outside the issuer', () => {
    expect(() => parseWorkloadBootstrapResponse(200, JSON.stringify({ ...BOOTSTRAP, bootstrap_version: 2 })))
      .toThrow(/bootstrap version/);
    expect(() => parseWorkloadBootstrapResponse(200, JSON.stringify({ ...BOOTSTRAP, token_endpoint: 'https://evil.example/token' })))
      .toThrow(/exact advertised issuer/);
    expect(() => parseWorkloadBootstrapResponse(200, JSON.stringify({ ...BOOTSTRAP, issuer: 'http://auth.example/realms/a', token_endpoint: 'http://auth.example/realms/a/protocol/openid-connect/token' })))
      .toThrow(/HTTPS/);
  });

  it('validates the token response', () => {
    expect(parseWorkloadTokenResponse(200, JSON.stringify({ access_token: 't', token_type: 'Bearer', expires_in: 900 })))
      .toEqual({ accessToken: 't', cacheSeconds: 300 });
    expect(() => parseWorkloadTokenResponse(200, JSON.stringify({ access_token: 't', token_type: 'Bearer', expires_in: 10 })))
      .toThrow(/too short/);
    expect(() => parseWorkloadTokenResponse(400, '')).toThrow(expect.objectContaining({ kind: 'auth' }));
  });
});

describe('client assertion', () => {
  it('is an RS256 JWT for the token endpoint, verifiable with the public key', () => {
    const jwt = buildClientAssertion(loadWorkloadPrivateKey(PEM), {
      kid: 'key-1',
      clientId: 'agent-client',
      tokenEndpoint: BOOTSTRAP.token_endpoint,
    }, 1_700_000_000, 'jti-1');
    const [h, c, sig] = jwt.split('.');
    expect(decodePart(h)).toEqual({ alg: 'RS256', kid: 'key-1', typ: 'JWT' });
    expect(decodePart(c)).toEqual({
      aud: BOOTSTRAP.token_endpoint,
      exp: 1_700_000_060,
      iat: 1_700_000_000,
      iss: 'agent-client',
      jti: 'jti-1',
      sub: 'agent-client',
    });
    expect(verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
  });

  it('accepts a PEM with escaped line breaks and rejects a non-RSA key', () => {
    expect(() => loadWorkloadPrivateKey(PEM.replace(/\n/g, '\\n'))).not.toThrow();
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => loadWorkloadPrivateKey(ec)).toThrow(/RSA/);
    expect(() => loadWorkloadPrivateKey('not a key')).toThrow(/valid PEM/);
  });
});

describe('getWorkloadAuth', () => {
  it('bootstraps, exchanges a token, and caches it', async () => {
    const { calls, http } = fakeAuthority();
    const authorities: string[] = [];
    const first = await getWorkloadAuth(http, CRED, (doc) => authorities.push(doc.issuer));
    const second = await getWorkloadAuth(http, CRED);
    expect(first?.token).toBe('token-2');
    expect(second?.token).toBe('token-2');
    expect(calls).toHaveLength(2);
    expect(authorities).toEqual([ISSUER]);

    const form = new URLSearchParams(calls[1].body);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_id')).toBe('agent-client');
    expect(form.get('client_assertion_type')).toBe(CLIENT_ASSERTION_TYPE);
    expect(form.get('client_assertion')?.split('.')).toHaveLength(3);
  });

  it('shares one acquisition between concurrent callers', async () => {
    const { calls, http } = fakeAuthority();
    const [a, b] = await Promise.all([getWorkloadAuth(http, CRED), getWorkloadAuth(http, CRED)]);
    expect(a?.token).toBe(b?.token);
    expect(calls).toHaveLength(2);
  });

  it('returns null when Core has no v3 authority, and does not ask again for a minute', async () => {
    const { calls, http } = fakeAuthority({ bootstrapStatus: 404 });
    expect(await getWorkloadAuth(http, CRED)).toBeNull();
    expect(await getWorkloadAuth(http, CRED)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('bootstraps again after the token is invalidated', async () => {
    const { calls, http } = fakeAuthority();
    const first = await getWorkloadAuth(http, CRED);
    invalidateWorkloadToken(CRED, first!.token);
    const second = await getWorkloadAuth(http, CRED);
    expect(second?.token).not.toBe(first?.token);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET', 'POST']);
  });

  it('fails before any request when the key is invalid', async () => {
    const { calls, http } = fakeAuthority();
    await expect(getWorkloadAuth(http, { ...CRED, privateKeyPem: 'nope' })).rejects.toThrow(/valid PEM/);
    expect(calls).toHaveLength(0);
  });
});

/** An n8n execute context whose httpRequest plays Core + Keycloak. */
function fakeContext(opts: { coreStatus?: number; bootstrapStatus?: number; credentials?: Record<string, unknown> } = {}) {
  const requests: Array<Record<string, unknown>> = [];
  const httpRequest = vi.fn(async (options: Record<string, unknown>) => {
    requests.push(options);
    const url = String(options.url);
    if (url.endsWith('/api/v3/auth/bootstrap')) {
      const status = opts.bootstrapStatus ?? 200;
      return { statusCode: status, body: status === 200 ? JSON.stringify(BOOTSTRAP) : '{}' };
    }
    if (url === BOOTSTRAP.token_endpoint) {
      return { statusCode: 200, body: JSON.stringify({ access_token: 'wl-token', token_type: 'Bearer', expires_in: 300 }) };
    }
    const status = opts.coreStatus ?? 200;
    if (status >= 400) throw Object.assign(new Error(`HTTP ${status}`), { httpCode: String(status) });
    return JSON.stringify({ verdict: 'allow' });
  });
  const ctx = {
    getCredentials: async () => ({ openboxUrl: API_URL, apiKey: 'obx_live_test', workloadPrivateKey: PEM, ...opts.credentials }),
    getNode: () => ({ name: 'OpenBox Agent' }),
    helpers: { httpRequest },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ctx: ctx as any, requests };
}

describe('openboxRequest with a workload key', () => {
  it('sends governance requests to the v3 path with the workload token, unsigned', async () => {
    const { ctx, requests } = fakeContext({
      credentials: { agentDid: 'did:aip:x', agentPrivateKey: Buffer.alloc(32).toString('base64') },
    });
    await openboxRequest(ctx, { method: 'POST', path: '/api/v1/governance/evaluate', body: { event_type: 'WorkflowStarted' } });
    const core = requests.at(-1)!;
    const headers = core.headers as Record<string, string>;
    expect(core.url).toBe(`${API_URL}/api/v3/governance/evaluate`);
    expect(headers['X-OpenBox-Workload-Token']).toBe('wl-token');
    expect(headers.Authorization).toBe('Bearer obx_live_test');
    expect(headers['X-OpenBox-SDK-Version']).toBe(SDK_IDENTITY);
    expect(headers['X-OpenBox-Agent-Signature']).toBeUndefined();
    // The Keycloak authority is never captured as a hook span.
    expect(shouldIgnore(BOOTSTRAP.token_endpoint)).toBe(true);
  });

  it('falls back to v1 when Core has no v3 authority for the agent', async () => {
    const { ctx, requests } = fakeContext({ bootstrapStatus: 404 });
    await openboxRequest(ctx, { method: 'POST', path: '/api/v1/governance/approval', body: {} });
    expect(requests.at(-1)!.url).toBe(`${API_URL}/api/v1/governance/approval`);
  });

  it('fails closed on 401, discards the token, and bootstraps again next time', async () => {
    const { ctx, requests } = fakeContext({ coreStatus: 401 });
    await expect(openboxRequest(ctx, { method: 'POST', path: '/api/v1/governance/evaluate', body: {} }))
      .rejects.toBeInstanceOf(GovernanceAuthError);
    await expect(openboxRequest(ctx, { method: 'POST', path: '/api/v1/governance/evaluate', body: {} }))
      .rejects.toBeInstanceOf(GovernanceAuthError);
    expect(requests.filter((r) => String(r.url).endsWith('/api/v3/auth/bootstrap'))).toHaveLength(2);
  });

  it('reports an unreachable bootstrap as a soft (onApiError) failure', async () => {
    const { ctx } = fakeContext({ bootstrapStatus: 503 });
    await expect(openboxRequest(ctx, { method: 'POST', path: '/api/v1/governance/evaluate', body: {} }))
      .rejects.toBeInstanceOf(SoftGovernanceError);
  });
});

describe('SDK version header', () => {
  it('follows openbox-{engine}-{language}-v{version}', () => {
    expect(SDK_IDENTITY).toMatch(/^openbox-n8n-typescript-v\d+\.\d+\.\d+/);
  });
});
