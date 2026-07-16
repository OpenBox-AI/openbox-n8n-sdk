import { describe, expect, it } from 'vitest';

import {
  normalizeOpenBoxCredentials,
  OpenBoxApi,
} from '../credentials/OpenBoxApi.credentials';

describe('OpenBoxApi credential descriptor', () => {
  const cred = new OpenBoxApi();

  it('uses the canonical n8n credential name', () => {
    expect(cred.name).toBe('openBoxApi');
  });

  it('exposes the required fields', () => {
    const names = cred.properties.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['apiKey', 'agentDid', 'agentPrivateKey']));
  });

  it('exposes an optional API base URL (for self-hosted Core) but no org/project/environment fields', () => {
    const names = cred.properties.map((p) => p.name);
    expect(names).toContain('openboxUrl');
    expect(names).not.toContain('organizationId');
    expect(names).not.toContain('projectId');
    expect(names).not.toContain('environment');
  });

  it('marks the API key as a password field', () => {
    const apiKeyProp = cred.properties.find((p) => p.name === 'apiKey');
    expect(apiKeyProp?.typeOptions).toMatchObject({ password: true });
  });

  it('points the connection test at /api/v1/auth/validate', () => {
    expect(cred.test.request.url).toBe('/api/v1/auth/validate');
    expect(cred.test.request.method).toBe('GET');
  });

  it('defaults the base URL to core.openbox.ai but allows overriding it via the credential field', () => {
    expect(cred.test.request.baseURL).toContain('https://core.openbox.ai');
    expect(cred.test.request.baseURL).toContain('$credentials.openboxUrl');
  });
});

describe('normalizeOpenBoxCredentials', () => {
  const valid = { apiKey: 'obx_live_abc' };

  it('defaults to the hardcoded OpenBox URL when none is supplied', () => {
    const out = normalizeOpenBoxCredentials(valid);
    expect(out.openboxUrl).toBe('https://core.openbox.ai');
  });

  it('uses a self-hosted URL when supplied, trimming a trailing slash', () => {
    const out = normalizeOpenBoxCredentials({ ...valid, openboxUrl: 'https://openbox.internal.example.com/' });
    expect(out.openboxUrl).toBe('https://openbox.internal.example.com');
  });

  it('throws on missing apiKey', () => {
    expect(() => normalizeOpenBoxCredentials({ apiKey: '' })).toThrow(/api key/i);
  });

  it('passes through agentDid and agentPrivateKey when provided', () => {
    const out = normalizeOpenBoxCredentials({
      ...valid,
      agentDid: 'did:aip:abc',
      agentPrivateKey: 'base64key==',
    });
    expect(out.agentDid).toBe('did:aip:abc');
    expect(out.agentPrivateKey).toBe('base64key==');
  });

  it('returns undefined for optional fields when omitted', () => {
    const out = normalizeOpenBoxCredentials(valid);
    expect(out.agentDid).toBeUndefined();
    expect(out.agentPrivateKey).toBeUndefined();
  });
});
