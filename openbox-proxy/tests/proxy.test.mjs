import { describe, expect, it, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const cjsRequire = createRequire(import.meta.url);

describe('governance.allowedVerdict', () => {
  const { allowedVerdict } = cjsRequire('../src/governance.js');

  it.each(['allow', 'constrain'])('returns true for arm=%s', (arm) => {
    expect(allowedVerdict({ arm })).toBe(true);
  });

  it.each(['block', 'halt', 'require_approval', 'error', undefined, null])(
    'returns false for arm=%s',
    (arm) => {
      expect(allowedVerdict({ arm })).toBe(false);
    },
  );

  it('returns false for non-object inputs', () => {
    expect(allowedVerdict(undefined)).toBe(false);
    expect(allowedVerdict(null)).toBe(false);
    expect(allowedVerdict('allow')).toBe(false);
  });

  it('falls back to action / verdict fields for legacy envelopes', () => {
    expect(allowedVerdict({ action: 'allow' })).toBe(true);
    expect(allowedVerdict({ verdict: 'constrain' })).toBe(true);
  });
});

describe('governance.maskUrl', () => {
  const { maskUrl } = cjsRequire('../src/governance.js');

  it('strips query strings', () => {
    expect(maskUrl('https://api.example.com/v1/x?key=secret')).toBe(
      'https://api.example.com/v1/x',
    );
  });

  it('handles malformed URLs without throwing', () => {
    expect(maskUrl('not a url')).toBe('not a url');
    expect(maskUrl('')).toBe('unknown');
    expect(maskUrl(undefined)).toBe('unknown');
  });
});

describe('server helpers', () => {
  beforeEach(() => {
    delete cjsRequire.cache[cjsRequire.resolve('../src/server.js')];
  });

  it('strips hop-by-hop headers', () => {
    process.env.OPENBOX_API_URL = 'https://core.openbox.ai';
    process.env.OPENBOX_API_KEY = 'obx_test_x';
    const { stripHopByHop } = cjsRequire('../src/server.js');
    const out = stripHopByHop({
      Host: 'api.example.com',
      Connection: 'close',
      'Proxy-Authorization': 'Bearer x',
      'Transfer-Encoding': 'chunked',
      'Content-Type': 'application/json',
    });
    expect(out).toMatchObject({ Host: 'api.example.com', 'Content-Type': 'application/json' });
    expect(out).not.toHaveProperty('Connection');
    expect(out).not.toHaveProperty('Proxy-Authorization');
    expect(out).not.toHaveProperty('Transfer-Encoding');
  });

  it('exempts the OpenBox API host from governance', () => {
    process.env.OPENBOX_API_URL = 'https://core.openbox.ai';
    process.env.OPENBOX_API_KEY = 'obx_test_x';
    process.env.NO_PROXY = 'postgres,localhost';
    const { isExempt } = cjsRequire('../src/server.js');
    expect(isExempt('core.openbox.ai')).toBe(true);
    expect(isExempt('postgres')).toBe(true);
    expect(isExempt('sub.localhost')).toBe(true);
    expect(isExempt('api.slack.com')).toBe(false);
  });

  it('handles a missing OPENBOX_API_URL without throwing', () => {
    delete process.env.OPENBOX_API_URL;
    process.env.NO_PROXY = '';
    const { isExempt } = cjsRequire('../src/server.js');
    expect(isExempt('anywhere.example.com')).toBe(false);
  });
});
