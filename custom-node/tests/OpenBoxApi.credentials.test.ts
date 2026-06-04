import { describe, expect, it } from 'vitest';

import {
  normalizeOpenBoxCredentials,
  OpenBoxApi,
} from '../src/credentials/OpenBoxApi.credentials';

describe('OpenBoxApi credential descriptor', () => {
  const cred = new OpenBoxApi();

  it('uses the canonical n8n credential name', () => {
    expect(cred.name).toBe('openBoxApi');
  });

  it('exposes the required fields', () => {
    const names = cred.properties.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['apiKey', 'agentDid', 'agentPrivateKey']));
  });

  it('does not expose url, org, project, or environment fields', () => {
    const names = cred.properties.map((p) => p.name);
    expect(names).not.toContain('openboxUrl');
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

  it('hardcodes the base URL to core.openbox.ai', () => {
    expect(cred.test.request.baseURL).toBe('https://core.openbox.ai');
  });
});

describe('normalizeOpenBoxCredentials', () => {
  const valid = { apiKey: 'obx_live_abc' };

  it('always returns the hardcoded OpenBox URL', () => {
    const out = normalizeOpenBoxCredentials(valid);
    expect(out.openboxUrl).toBe('https://core.openbox.ai');
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
