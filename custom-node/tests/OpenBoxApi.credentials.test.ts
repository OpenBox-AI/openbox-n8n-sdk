import { describe, expect, it } from 'vitest';

import {
  normalizeOpenBoxCredentials,
  OpenBoxApi,
} from '../src/credentials/OpenBoxApi.credentials';

describe('OpenBoxApi credential descriptor', () => {
  const cred = new OpenBoxApi();

  it('uses the canonical n8n credential name', () => {
    // Other nodes reference this string by literal; renaming is a
    // breaking change that must be intentional.
    expect(cred.name).toBe('openBoxApi');
  });

  it('exposes every PRD-required field', () => {
    const names = cred.properties.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'openboxUrl',
        'apiKey',
        'organizationId',
        'projectId',
        'environment',
        'timeoutMs',
        'failPolicy',
        'enforceHttps',
        'webhookSecret',
      ]),
    );
  });

  it('marks the API key as a password field', () => {
    const apiKeyProp = cred.properties.find((p) => p.name === 'apiKey');
    expect(apiKeyProp?.typeOptions).toMatchObject({ password: true });
  });

  it('points the connection test at /api/v1/auth/validate', () => {
    expect(cred.test.request.url).toBe('/api/v1/auth/validate');
    expect(cred.test.request.method).toBe('GET');
  });
});

describe('normalizeOpenBoxCredentials', () => {
  const valid = {
    openboxUrl: 'https://core.openbox.ai/',
    apiKey: 'obx_live_abc',
    environment: 'production',
    timeoutMs: 35000,
    failPolicy: 'fail_closed',
    enforceHttps: true,
  };

  it('strips trailing slashes from the URL', () => {
    const out = normalizeOpenBoxCredentials({ ...valid, openboxUrl: 'https://x/' });
    expect(out.openboxUrl).toBe('https://x');
  });

  it('rejects http URLs when enforceHttps is true', () => {
    expect(() =>
      normalizeOpenBoxCredentials({ ...valid, openboxUrl: 'http://localhost:8086' }),
    ).toThrow(/HTTPS/i);
  });

  it('allows http URLs when enforceHttps is explicitly false', () => {
    const out = normalizeOpenBoxCredentials({
      ...valid,
      openboxUrl: 'http://localhost:8086',
      enforceHttps: false,
    });
    expect(out.openboxUrl).toBe('http://localhost:8086');
  });

  it('throws on missing apiKey', () => {
    expect(() => normalizeOpenBoxCredentials({ ...valid, apiKey: '' })).toThrow(/api key/i);
  });

  it('throws on missing url', () => {
    expect(() => normalizeOpenBoxCredentials({ ...valid, openboxUrl: '' })).toThrow(
      /openbox url/i,
    );
  });

  it('coerces an unparseable timeout to the 35s default', () => {
    const out = normalizeOpenBoxCredentials({ ...valid, timeoutMs: 'abc' as unknown as number });
    expect(out.timeoutMs).toBe(35000);
  });

  it('honors a positive timeout override', () => {
    const out = normalizeOpenBoxCredentials({ ...valid, timeoutMs: 10000 });
    expect(out.timeoutMs).toBe(10000);
  });

  it('drops empty optional scoping fields', () => {
    const out = normalizeOpenBoxCredentials({
      ...valid,
      organizationId: '',
      projectId: '',
      webhookSecret: '',
    });
    expect(out.organizationId).toBeUndefined();
    expect(out.projectId).toBeUndefined();
    expect(out.webhookSecret).toBeUndefined();
  });

  it('defaults missing failPolicy to fail_closed', () => {
    const out = normalizeOpenBoxCredentials({
      ...valid,
      failPolicy: undefined as unknown as string,
    });
    expect(out.failPolicy).toBe('fail_closed');
  });

  it('defaults missing environment to production', () => {
    const out = normalizeOpenBoxCredentials({
      ...valid,
      environment: undefined as unknown as string,
    });
    expect(out.environment).toBe('production');
  });
});
