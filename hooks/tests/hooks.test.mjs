/**
 * Unit tests for the OpenBox external hook module.
 *
 * Vitest 4 requires ESM, so this file uses `import` syntax. The
 * underlying hook modules are CommonJS — Node's interop loads them
 * via the default-export shim, then we destructure the named
 * exports out manually.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

// We use a CJS require() inside ESM so we can blow away the require
// cache between tests when we're exercising module-level state.
const cjsRequire = createRequire(import.meta.url);

describe('openbox-hooks-db helpers', () => {
  const { __test__ } = cjsRequire('../openbox-hooks-db.js');

  it('classifies SELECT statements', () => {
    expect(__test__.classifySql('SELECT * FROM t')).toBe('SELECT');
    expect(__test__.classifySql('  insert into t values (1)')).toBe('INSERT');
    expect(__test__.classifySql('UPDATE t SET x=1')).toBe('UPDATE');
  });

  it('returns QUERY for unparseable / empty inputs', () => {
    expect(__test__.classifySql('')).toBe('QUERY');
    expect(__test__.classifySql(undefined)).toBe('QUERY');
    expect(__test__.classifySql(null)).toBe('QUERY');
  });

  it('extracts SQL from string and {text} forms', () => {
    expect(__test__.extractSql(['SELECT 1'])).toBe('SELECT 1');
    expect(__test__.extractSql([{ text: 'SELECT 1', values: [] }])).toBe('SELECT 1');
  });

  it('returns the database name from connectionParameters fallback', () => {
    expect(__test__.databaseName({ database: 'app' })).toBe('app');
    expect(
      __test__.databaseName({ connectionParameters: { database: 'fallback' } }),
    ).toBe('fallback');
    expect(__test__.databaseName(undefined)).toBe('unknown');
  });
});

describe('openbox-hooks-http helpers', () => {
  const { __test__ } = cjsRequire('../openbox-hooks-http.js');

  it('reconstructs a URL from a request-like object', () => {
    const url = __test__.buildRequestUrl({
      protocol: 'https:',
      host: 'api.example.com:443',
      path: '/v1/things?x=1',
    });
    expect(url).toBe('https://api.example.com:443/v1/things?x=1');
  });

  it('redacts authorization / cookie / *-api-key headers', () => {
    const out = __test__.safeHeaders({
      getHeaders: () => ({
        Authorization: 'Bearer secret',
        Cookie: 'session=...',
        'X-Api-Key': 'k',
        'Content-Type': 'application/json',
      }),
    });
    expect(out).not.toHaveProperty('Authorization');
    expect(out).not.toHaveProperty('Cookie');
    expect(out).not.toHaveProperty('X-Api-Key');
    expect(out['Content-Type']).toBe('application/json');
  });

  it('flattens array-valued headers and tolerates missing getHeaders', () => {
    const flat = __test__.safeHeaders({
      getHeaders: () => ({ 'Set-Cookie': ['a=1', 'b=2'] }),
    });
    expect(flat['Set-Cookie']).toBe('a=1,b=2');
    expect(__test__.safeHeaders({})).toEqual({});
    expect(__test__.safeHeaders(undefined)).toEqual({});
  });
});

describe('openbox-hooks-transport URL filtering', () => {
  beforeEach(() => {
    // Re-evaluate the module after rewriting OPENBOX_API_URL so the
    // module-level constants pick up the new value.
    delete cjsRequire.cache[cjsRequire.resolve('../openbox-hooks-transport.js')];
  });

  it('treats requests to OPENBOX_API_URL as self-traffic', () => {
    process.env.OPENBOX_API_URL = 'https://core.openbox.ai';
    const { isOpenBoxUrl } = cjsRequire('../openbox-hooks-transport.js');
    expect(isOpenBoxUrl('https://core.openbox.ai/api/v1/governance/spans')).toBe(true);
    expect(isOpenBoxUrl('https://other.example.com/x')).toBe(false);
    expect(isOpenBoxUrl('')).toBe(false);
    expect(isOpenBoxUrl(undefined)).toBe(false);
  });

  it('returns false when OPENBOX_API_URL is not set', () => {
    delete process.env.OPENBOX_API_URL;
    const { isOpenBoxUrl } = cjsRequire('../openbox-hooks-transport.js');
    expect(isOpenBoxUrl('https://anything.example.com')).toBe(false);
  });
});

describe('openbox-hooks state isolation', () => {
  it('exposes empty containers on first require', () => {
    delete cjsRequire.cache[cjsRequire.resolve('../openbox-hooks-state.js')];
    const state = cjsRequire('../openbox-hooks-state.js');
    expect(state.hooks.ready).toBe(false);
    expect(state.sessions.size).toBe(0);
    expect(state.abortedExecutions.size).toBe(0);
    expect(state.pendingHttpSpans).toBeInstanceOf(WeakMap);
  });

  it('shares state across requires (module singleton)', () => {
    const a = cjsRequire('../openbox-hooks-state.js');
    const b = cjsRequire('../openbox-hooks-state.js');
    a.sessions.set('shared', { ok: true });
    expect(b.sessions.get('shared')).toEqual({ ok: true });
    a.sessions.delete('shared');
  });
});
