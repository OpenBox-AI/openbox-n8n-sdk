import {
  IAuthenticateGeneric,
  ICredentialDataDecryptedObject,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

/**
 * Credentials for the OpenBox governance plane.
 *
 * Encrypts the agent API key in n8n's credential vault, exposes
 * organization/project scoping headers, lets users pin an environment,
 * and enforces HTTPS by default. The built-in connection test hits
 * `GET /api/v1/auth/validate`, which is the canonical OpenBox key
 * validation endpoint.
 *
 * One credential, reused by every OpenBox node (LLM, generic action,
 * trigger). Consumers MUST go through this type rather than reading
 * `OPENBOX_API_KEY` from the environment so secrets stay encrypted at
 * rest and rotation can happen in a single place.
 */
export class OpenBoxApi implements ICredentialType {
  name = 'openBoxApi';
  displayName = 'OpenBox API';
  documentationUrl = 'https://docs.openbox.ai/integrations/n8n';
  icon = 'file:openbox.svg' as const;

  properties: INodeProperties[] = [
    {
      displayName: 'OpenBox URL',
      name: 'openboxUrl',
      type: 'string',
      default: 'https://core.openbox.ai',
      placeholder: 'https://core.openbox.ai',
      description:
        'Base URL of the OpenBox Core API. Should be HTTPS in production unless "Enforce HTTPS" is disabled.',
      required: true,
    },
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description:
        'Agent API key issued by OpenBox. Live keys start with "obx_live_"; test keys with "obx_test_".',
    },
    {
      displayName: 'Organization ID',
      name: 'organizationId',
      type: 'string',
      default: '',
      description:
        'Optional. Forwarded as the X-OpenBox-Organization header to scope multi-org accounts.',
    },
    {
      displayName: 'Project ID',
      name: 'projectId',
      type: 'string',
      default: '',
      description:
        'Optional. Forwarded as the X-OpenBox-Project header to scope project-level governance rules.',
    },
    {
      displayName: 'Environment',
      name: 'environment',
      type: 'options',
      options: [
        { name: 'Production', value: 'production' },
        { name: 'Staging', value: 'staging' },
        { name: 'Development', value: 'development' },
      ],
      default: 'production',
      description:
        'Must match the environment the agent key was issued for. Use "Production" for keys from core.openbox.ai. Forwarded as X-OpenBox-Environment.',
    },
    {
      displayName: 'Timeout (ms)',
      name: 'timeoutMs',
      type: 'number',
      default: 35000,
      typeOptions: { minValue: 1000, maxValue: 600000 },
      description:
        'HTTP request timeout in milliseconds. Defaults to 35s; sits slightly above core\'s 30s workflow execution deadline so server-side timeouts surface their real error message.',
    },
    {
      displayName: 'Fail Policy',
      name: 'failPolicy',
      type: 'options',
      options: [
        {
          name: 'Fail Closed (block on governance errors)',
          value: 'fail_closed',
          description: 'Recommended for production. Workflow fails if OpenBox is unreachable.',
        },
        {
          name: 'Fail Open (allow on governance errors)',
          value: 'fail_open',
          description: 'Best-effort governance. Workflow continues if OpenBox is unreachable.',
        },
      ],
      default: 'fail_closed',
      description: 'Behavior when OpenBox returns 5xx or is unreachable.',
    },
    {
      displayName: 'Enforce HTTPS',
      name: 'enforceHttps',
      type: 'boolean',
      default: true,
      description:
        'Reject non-HTTPS OpenBox URLs at request time. Disable only for local development.',
    },
    {
      displayName: 'Agent DID',
      name: 'agentDid',
      type: 'string',
      default: '',
      description:
        'Optional. Agent decentralized identifier (format: did:aip:<uuid>). Required for agents with signing_required=true. Pair with Agent Private Key.',
      placeholder: 'did:aip:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    },
    {
      displayName: 'Agent Private Key',
      name: 'agentPrivateKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description:
        'Optional. Base64-encoded raw 32-byte Ed25519 seed. Every request is signed locally with this key. Required for agents with signing_required=true. Pair with Agent DID.',
    },
    {
      displayName: 'Webhook Signing Secret',
      name: 'webhookSecret',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description:
        'Optional. Shared secret used by the OpenBox Trigger node to verify HMAC-SHA256 signatures on inbound webhooks (X-OpenBox-Signature header).',
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: {
        Authorization: '=Bearer {{$credentials.apiKey}}',
        'Content-Type': 'application/json',
        'User-Agent': 'n8n-nodes-openbox-hook/0.0.1',
        'X-OpenBox-SDK-Version': '0.0.1',
        'X-OpenBox-Organization':
          '={{$credentials.organizationId ? $credentials.organizationId : undefined}}',
        'X-OpenBox-Project':
          '={{$credentials.projectId ? $credentials.projectId : undefined}}',
        'X-OpenBox-Environment': '={{$credentials.environment}}',
      },
    },
  };

}

/**
 * Strongly-typed view of the decrypted credential payload. Nodes pull
 * `this.getCredentials('openBoxApi')` and pass the result through
 * `normalizeOpenBoxCredentials` to obtain this shape.
 *
 * NOTE: this interface intentionally does NOT extend
 * `ICredentialDataDecryptedObject`; that type carries an index
 * signature (`[key: string]: CredentialInformation`) which forbids
 * `string | undefined` properties. Keeping it standalone lets us
 * model truly optional fields without lying about the runtime shape.
 */
export interface OpenBoxCredentials {
  openboxUrl: string;
  apiKey: string;
  organizationId?: string;
  projectId?: string;
  environment: 'production' | 'staging' | 'development';
  timeoutMs: number;
  failPolicy: 'fail_closed' | 'fail_open';
  enforceHttps: boolean;
  agentDid?: string;
  agentPrivateKey?: string;
  webhookSecret?: string;
}

/**
 * Normalize and validate the raw credential object before use. Trims
 * trailing slashes from the base URL, enforces the HTTPS toggle, and
 * fills in any defaults that an older saved credential might not have.
 *
 * Throws a plain Error so callers can wrap it as a NodeOperationError
 * with the offending node attached.
 */
export function normalizeOpenBoxCredentials(
  raw: ICredentialDataDecryptedObject,
): OpenBoxCredentials {
  const url = String(raw.openboxUrl ?? '').trim().replace(/\/+$/, '');
  if (!url) {
    throw new Error('OpenBox credential is missing the OpenBox URL.');
  }
  const apiKey = String(raw.apiKey ?? '').trim();
  if (!apiKey) {
    throw new Error('OpenBox credential is missing the API key.');
  }

  const enforceHttps = raw.enforceHttps !== false;
  if (enforceHttps && !/^https:\/\//i.test(url)) {
    throw new Error(
      `OpenBox URL must use HTTPS when "Enforce HTTPS" is enabled. Got: ${url}`,
    );
  }

  const env = (raw.environment as OpenBoxCredentials['environment']) || 'production';
  const failPolicy =
    (raw.failPolicy as OpenBoxCredentials['failPolicy']) || 'fail_closed';

  const timeoutCandidate = Number(raw.timeoutMs);
  const timeoutMs =
    Number.isFinite(timeoutCandidate) && timeoutCandidate > 0 ? timeoutCandidate : 35000;

  return {
    openboxUrl: url,
    apiKey,
    organizationId: raw.organizationId ? String(raw.organizationId) : undefined,
    projectId: raw.projectId ? String(raw.projectId) : undefined,
    environment: env,
    timeoutMs,
    failPolicy,
    enforceHttps,
    agentDid: raw.agentDid ? String(raw.agentDid) : undefined,
    agentPrivateKey: raw.agentPrivateKey ? String(raw.agentPrivateKey) : undefined,
    webhookSecret: raw.webhookSecret ? String(raw.webhookSecret) : undefined,
  };
}
