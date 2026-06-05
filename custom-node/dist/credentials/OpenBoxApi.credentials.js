"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenBoxApi = void 0;
exports.normalizeOpenBoxCredentials = normalizeOpenBoxCredentials;
const DEFAULT_OPENBOX_URL = 'https://core.openbox.ai';
class OpenBoxApi {
    name = 'openBoxApi';
    displayName = 'OpenBox API';
    documentationUrl = 'https://docs.openbox.ai/integrations/n8n';
    icon = 'file:openbox.svg';
    properties = [
        {
            displayName: 'API Key',
            name: 'apiKey',
            type: 'string',
            typeOptions: { password: true },
            default: '',
            required: true,
            description: 'Agent API key issued by OpenBox. Live keys start with "obx_live_"; test keys with "obx_test_".',
        },
        {
            displayName: 'Agent DID',
            name: 'agentDid',
            type: 'string',
            default: '',
            description: 'Optional. Agent decentralized identifier (format: did:aip:<uuid>). Required for agents with signing_required=true. Pair with Agent Private Key.',
            placeholder: 'did:aip:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
        },
        {
            displayName: 'Agent Private Key',
            name: 'agentPrivateKey',
            type: 'string',
            typeOptions: { password: true },
            default: '',
            description: 'Optional. Base64-encoded raw 32-byte Ed25519 seed. Every request is signed locally with this key. Required for agents with signing_required=true. Pair with Agent DID.',
        },
    ];
    test = {
        request: {
            baseURL: DEFAULT_OPENBOX_URL,
            url: '/api/v1/auth/validate',
            method: 'GET',
        },
    };
    authenticate = {
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
exports.OpenBoxApi = OpenBoxApi;
function normalizeOpenBoxCredentials(raw) {
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
