"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenBoxTrigger = void 0;
exports.humanize = humanize;
exports.verifyHmac = verifyHmac;
exports.parseEvent = parseEvent;
exports.matchesFilters = matchesFilters;
const crypto_1 = require("crypto");
const n8n_workflow_1 = require("n8n-workflow");
const OpenBoxApi_credentials_1 = require("../../credentials/OpenBoxApi.credentials");
const credential_test_1 = require("../../shared/credential-test");
/**
 * Canonical OpenBox webhook event types. Mirrors the values emitted by
 * OpenBox Core; new types should be appended here so the dropdown
 * stays in sync without breaking existing workflows.
 */
const SUPPORTED_EVENTS = [
    'approval.resolved',
    'approval.requested',
    'approval.expired',
    'policy.changed',
    'trust.tier_changed',
    'alert.created',
    'alert.resolved',
];
/**
 * Webhook trigger for OpenBox events. n8n exposes a stable URL that
 * users register inside the OpenBox console as a webhook destination.
 *
 * Security model:
 *   1. The credential's `webhookSecret` is used to verify an
 *      HMAC-SHA256 signature delivered via `X-OpenBox-Signature`.
 *   2. Replay protection is provided by `X-OpenBox-Timestamp` with a
 *      5-minute tolerance window (configurable).
 *   3. Event-type filtering happens server-side in OpenBox AND
 *      client-side here, so misconfigured webhooks fail closed.
 *
 * Limitation (per gaps.md):
 *   This trigger CANNOT resume a paused workflow. n8n's external
 *   webhook model always starts a new execution. Workflows that need
 *   to wait on an approval should use the OpenBox action node's
 *   "Poll Approval" operation in a long-running execution.
 */
class OpenBoxTrigger {
    description = {
        displayName: 'OpenBox Trigger',
        name: 'openBoxTrigger',
        icon: 'file:OB_logomark.png',
        group: ['trigger'],
        version: 1,
        subtitle: '={{$parameter["events"].join(", ")}}',
        description: 'Starts a workflow when OpenBox emits an event (approval resolved, policy changed, trust tier changed, alert created, ...).',
        defaults: { name: 'OpenBox Trigger' },
        inputs: [],
        outputs: ['main'],
        credentials: [
            {
                name: 'openBoxApi',
                required: true,
                testedBy: 'openBoxApiCredentialTest',
            },
        ],
        webhooks: [
            {
                name: 'default',
                httpMethod: 'POST',
                responseMode: 'onReceived',
                path: 'openbox',
            },
        ],
        properties: [
            {
                displayName: 'Copy the production webhook URL above and register it under "Webhooks" in the OpenBox console. The credential\'s "Webhook Signing Secret" must match the secret OpenBox uses to sign payloads.',
                name: 'setupNotice',
                type: 'notice',
                default: '',
            },
            {
                displayName: 'Events',
                name: 'events',
                type: 'multiOptions',
                required: true,
                default: ['approval.resolved'],
                description: 'Only events of the selected types will trigger the workflow. Other events return 200 OK and are silently dropped.',
                options: SUPPORTED_EVENTS.map((value) => ({
                    name: humanize(value),
                    value,
                })),
            },
            {
                displayName: 'Filters',
                name: 'filters',
                type: 'collection',
                placeholder: 'Add Filter',
                default: {},
                options: [
                    {
                        displayName: 'Approval ID',
                        name: 'approvalId',
                        type: 'string',
                        default: '',
                        description: 'Only trigger for events whose approval_id matches this value.',
                    },
                    {
                        displayName: 'Workflow ID',
                        name: 'workflowId',
                        type: 'string',
                        default: '',
                        description: 'Only trigger for events whose workflow_id matches this value.',
                    },
                    {
                        displayName: 'Agent ID',
                        name: 'agentId',
                        type: 'string',
                        default: '',
                        description: 'Only trigger for events whose agent_id matches this value.',
                    },
                    {
                        displayName: 'Minimum Risk Score',
                        name: 'minRiskScore',
                        type: 'number',
                        typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
                        default: 0,
                        description: 'Only trigger when the event\'s risk_score is at least this value (0–1 range).',
                    },
                ],
            },
            {
                displayName: 'Signature Verification',
                name: 'signatureMode',
                type: 'options',
                options: [
                    {
                        name: 'Required (recommended)',
                        value: 'required',
                        description: 'Reject any request without a valid X-OpenBox-Signature header.',
                    },
                    {
                        name: 'Optional',
                        value: 'optional',
                        description: 'Verify when present, but accept unsigned requests. Use only behind a trusted gateway.',
                    },
                    {
                        name: 'Disabled (NOT for production)',
                        value: 'disabled',
                        description: 'Skip signature verification entirely. Local development only.',
                    },
                ],
                default: 'required',
            },
            {
                displayName: 'Timestamp Tolerance (seconds)',
                name: 'timestampToleranceSeconds',
                type: 'number',
                typeOptions: { minValue: 0, maxValue: 86400 },
                default: 300,
                description: 'Reject requests whose X-OpenBox-Timestamp differs from the server clock by more than this. Set to 0 to disable replay protection.',
            },
        ],
    };
    methods = {
        credentialTest: {
            openBoxApiCredentialTest: credential_test_1.testOpenBoxCredential,
        },
    };
    async webhook() {
        const headers = this.getHeaderData();
        const bodyRaw = this.getBodyData();
        const events = this.getNodeParameter('events', []);
        const filters = this.getNodeParameter('filters', {});
        const signatureMode = this.getNodeParameter('signatureMode', 'required');
        const timestampTolerance = this.getNodeParameter('timestampToleranceSeconds', 300) || 0;
        const credsRaw = await this.getCredentials('openBoxApi');
        let credentials;
        try {
            credentials = (0, OpenBoxApi_credentials_1.normalizeOpenBoxCredentials)(credsRaw);
        }
        catch (err) {
            throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Invalid OpenBox credential: ${err instanceof Error ? err.message : String(err)}`);
        }
        // ── Signature + replay verification ────────────────────────────
        const rawBody = readRawBody(this, bodyRaw);
        const signatureHeader = headerValue(headers, 'x-openbox-signature');
        const timestampHeader = headerValue(headers, 'x-openbox-timestamp');
        if (signatureMode !== 'disabled') {
            if (!credentials.webhookSecret) {
                throw new n8n_workflow_1.NodeOperationError(this.getNode(), 'Webhook signing secret is missing on the OpenBox credential. Either add one or set Signature Verification to "Disabled".');
            }
            if (!signatureHeader) {
                if (signatureMode === 'required') {
                    return rejectWith(401, 'Missing X-OpenBox-Signature header.');
                }
            }
            else {
                const signed = timestampHeader ? `${timestampHeader}.${rawBody}` : rawBody;
                const valid = verifyHmac(credentials.webhookSecret, signed, signatureHeader);
                if (!valid) {
                    return rejectWith(401, 'Invalid webhook signature.');
                }
            }
        }
        if (timestampTolerance > 0 && timestampHeader) {
            const ts = Number(timestampHeader);
            if (!Number.isFinite(ts)) {
                return rejectWith(400, 'Malformed X-OpenBox-Timestamp.');
            }
            const skewMs = Math.abs(Date.now() - ts * 1000);
            if (skewMs > timestampTolerance * 1000) {
                return rejectWith(401, 'Webhook timestamp outside tolerance window.');
            }
        }
        // ── Event-type filtering ───────────────────────────────────────
        const event = parseEvent(bodyRaw);
        if (!event) {
            return rejectWith(400, 'Webhook payload missing event type.');
        }
        if (events.length > 0 && !events.includes(event.type)) {
            // Acknowledge but do not trigger — keeps OpenBox from retrying.
            return { webhookResponse: { status: 'ignored' }, noWebhookResponse: false };
        }
        // ── Field-level filters ────────────────────────────────────────
        if (!matchesFilters(event.data, filters)) {
            return { webhookResponse: { status: 'filtered' }, noWebhookResponse: false };
        }
        return {
            workflowData: [
                [
                    {
                        json: {
                            event: event.type,
                            receivedAt: new Date().toISOString(),
                            data: event.data,
                            raw: bodyRaw,
                        },
                    },
                ],
            ],
        };
    }
}
exports.OpenBoxTrigger = OpenBoxTrigger;
// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────
/** Exported for unit tests. */
function humanize(slug) {
    return slug
        .split(/[._]/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}
function headerValue(headers, key) {
    // Header keys arrive lowercased from n8n's runtime, but be defensive
    // in case a future runtime preserves case.
    return headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()];
}
/**
 * n8n parses JSON bodies before handing them to the webhook handler,
 * which means we lose the raw bytes needed for HMAC verification.
 * Reconstruct a stable canonical form by re-serializing the parsed
 * body. This matches OpenBox's webhook signing convention, which
 * signs the JSON-stringified payload (no extra whitespace).
 */
function readRawBody(_ctx, body) {
    if (typeof body === 'string')
        return body;
    if (body === undefined || body === null)
        return '';
    try {
        return JSON.stringify(body);
    }
    catch {
        return String(body);
    }
}
/**
 * Constant-time HMAC-SHA256 verification. Accepts either a bare hex
 * digest or the prefixed "sha256=<hex>" form that many providers send.
 */
/** Exported for unit tests. */
function verifyHmac(secret, payload, signature) {
    const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    const expected = (0, crypto_1.createHmac)('sha256', secret).update(payload).digest('hex');
    if (provided.length !== expected.length)
        return false;
    try {
        return (0, crypto_1.timingSafeEqual)(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
    }
    catch {
        return false;
    }
}
/** Exported for unit tests. */
function parseEvent(body) {
    if (!body || typeof body !== 'object')
        return undefined;
    const obj = body;
    // Accept either {event, data} or {type, ...rest}; OpenBox's emitter
    // has historically used both shapes during the GA migration.
    const rawType = (obj.event ?? obj.type ?? obj.event_type);
    if (!rawType)
        return undefined;
    const type = rawType;
    const data = obj.data ?? obj;
    return { type, data };
}
/** Exported for unit tests. */
function matchesFilters(data, filters) {
    const approvalId = filters.approvalId;
    if (approvalId && data.approval_id !== approvalId && data.approvalId !== approvalId) {
        return false;
    }
    const workflowId = filters.workflowId;
    if (workflowId && data.workflow_id !== workflowId && data.workflowId !== workflowId) {
        return false;
    }
    const agentId = filters.agentId;
    if (agentId && data.agent_id !== agentId && data.agentId !== agentId) {
        return false;
    }
    const minRisk = filters.minRiskScore;
    if (typeof minRisk === 'number' && minRisk > 0) {
        const risk = (data.risk_score ?? data.riskScore);
        if (typeof risk !== 'number' || risk < minRisk)
            return false;
    }
    return true;
}
function rejectWith(status, message) {
    return {
        webhookResponse: {
            status,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: message }),
        },
        noWebhookResponse: false,
    };
}
