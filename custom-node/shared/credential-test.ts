import type {
  ICredentialTestFunctions,
  ICredentialsDecrypted,
  INodeCredentialTestResult,
} from 'n8n-workflow';

import { normalizeOpenBoxCredentials } from '../credentials/OpenBoxApi.credentials';
import { workloadHttpFor } from './openbox-client';
import { buildSignedHeaders } from './signing';
import { WORKLOAD_TOKEN_HEADER, WorkloadIdentityError, getWorkloadAuth } from './workload-identity';

const CREDENTIAL_TEST_TIMEOUT_MS = 30_000;

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

  // n8n-workflow 1.x types don't declare httpRequest on ICredentialTestFunctions,
  // but the runtime exposes it (the linter rule explicitly requires it).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const helpers = this.helpers as any;

  // With a workload key, the test proves the whole v3 chain: bootstrap, the
  // Keycloak token exchange, and Core accepting the token.
  let path = '/api/v1/auth/validate';
  let headers: Record<string, string>;
  let workloadToken: string | null = null;
  if (creds.workloadPrivateKey) {
    try {
      const auth = await getWorkloadAuth(workloadHttpFor(helpers, CREDENTIAL_TEST_TIMEOUT_MS), {
        apiUrl: creds.openboxUrl,
        apiKey: creds.apiKey,
        privateKeyPem: creds.workloadPrivateKey,
        coreHeaders: buildSignedHeaders('GET', '/api/v3/auth/bootstrap', Buffer.alloc(0), creds.apiKey),
      });
      if (auth) {
        workloadToken = auth.token;
        path = '/api/v3/auth/validate';
      }
    } catch (err) {
      const message = err instanceof WorkloadIdentityError ? err.message : String(err);
      return { status: 'Error', message: `OpenBox workload identity failed: ${message}` };
    }
  }
  if (workloadToken != null) {
    headers = { ...buildSignedHeaders('GET', path, Buffer.alloc(0), creds.apiKey), [WORKLOAD_TOKEN_HEADER]: workloadToken };
  } else {
    headers = buildSignedHeaders(
      'GET',
      path,
      Buffer.alloc(0),
      creds.apiKey,
      creds.agentDid,
      creds.agentPrivateKey,
    );
  }

  try {
    const response = await helpers.httpRequest({
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
    return {
      status: 'OK',
      message: workloadToken != null ? 'Connection successful (v3 workload identity)' : 'Connection successful',
    };
  } catch (err: unknown) {
    return {
      status: 'Error',
      message: `OpenBox credential test failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
