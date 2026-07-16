import { describe, expect, it } from 'vitest';

import pkg from '../package.json';
import { buildSignedHeaders } from '../shared/signing';

describe('buildSignedHeaders — version identity', () => {
  it('derives X-OpenBox-SDK-Version from package.json, not a hardcoded literal', () => {
    const headers = buildSignedHeaders('GET', '/api/v1/auth/validate', Buffer.alloc(0), 'obx_test_key');
    expect(headers['X-OpenBox-SDK-Version']).toBe(`openbox-langchain-typescript-v${pkg.version}`);
    expect(headers['User-Agent']).toBe(`n8n-nodes-openbox-hook/${pkg.version}`);
  });

  it('does not sign when agentDid/privateKey are absent', () => {
    const headers = buildSignedHeaders('GET', '/x', Buffer.alloc(0), 'k');
    expect(headers['X-OpenBox-Agent-Signature']).toBeUndefined();
  });
});
