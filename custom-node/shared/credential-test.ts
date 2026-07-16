import type {
  ICredentialTestFunctions,
  ICredentialsDecrypted,
  INodeCredentialTestResult,
} from 'n8n-workflow';

import { normalizeOpenBoxCredentials } from '../credentials/OpenBoxApi.credentials';
import { buildSignedHeaders } from './signing';

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
    // n8n-workflow 1.x types don't declare httpRequest on ICredentialTestFunctions,
    // but the runtime exposes it (the linter rule explicitly requires it).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (this.helpers as any).httpRequest({
      method: 'GET',
      url: `${creds.openboxUrl}${path}`,
      headers,
      json: true,
    });
    // Best-effort response-shape check — Core's exact schema for this endpoint
    // isn't documented, so only an explicit `valid: false` is treated as a
    // failure; anything else that didn't throw is accepted as success.
    if (response && typeof response === 'object' && 'valid' in response && !response.valid) {
      return { status: 'Error', message: 'OpenBox credential test failed: Core reported the credential as invalid' };
    }
    return { status: 'OK', message: 'Connection successful' };
  } catch (err: unknown) {
    return {
      status: 'Error',
      message: `OpenBox credential test failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
