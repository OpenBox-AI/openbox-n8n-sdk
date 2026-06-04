import {
  IAuthenticateGeneric,
  ICredentialDataDecryptedObject,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

const DEFAULT_OPENBOX_URL = 'https://core.openbox.ai';

export class OpenBoxApi implements ICredentialType {
  name = 'openBoxApi';
  displayName = 'OpenBox API';
  documentationUrl = 'https://docs.openbox.ai/integrations/n8n';
  icon = 'file:openbox.svg' as const;

  properties: INodeProperties[] = [
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
  ];

  test: ICredentialTestRequest = {
    request: {
      baseURL: DEFAULT_OPENBOX_URL,
      url: '/api/v1/auth/validate',
      method: 'GET',
    },
  };

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: {
        Authorization: '=Bearer {{$credentials.apiKey}}',
        'Content-Type': 'application/json',
        'User-Agent': 'n8n-nodes-openbox-hook/0.0.1',
        'X-OpenBox-SDK-Version': '0.0.1',
      },
    },
  };
}

export interface OpenBoxCredentials {
  openboxUrl: string;
  apiKey: string;
  agentDid?: string;
  agentPrivateKey?: string;
}

export function normalizeOpenBoxCredentials(
  raw: ICredentialDataDecryptedObject,
): OpenBoxCredentials {
  const apiKey = String(raw.apiKey ?? '').trim();
  if (!apiKey) {
    throw new Error('OpenBox credential is missing the API key.');
  }

  return {
    openboxUrl: (process.env.OPENBOX_API_URL ?? DEFAULT_OPENBOX_URL).replace(/\/+$/, ''),
    apiKey,
    agentDid: raw.agentDid ? String(raw.agentDid) : undefined,
    agentPrivateKey: raw.agentPrivateKey ? String(raw.agentPrivateKey) : undefined,
  };
}
