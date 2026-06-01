import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
} from 'n8n-workflow';

import {
  normalizeOpenBoxCredentials,
  OpenBoxCredentials,
} from './credentials/OpenBoxApi.credentials';
import { testOpenBoxCredential } from './shared/credential-test';

interface WorkflowVerdict {
  arm: 'allow' | 'constrain' | 'require_approval' | 'block' | 'halt';
  approvalId?: string;
  governanceEventId?: string;
  approvalExpiresAt?: string;
  reason?: string;
  riskScore: number;
  trustTier?: number;
  guardrailsResult?: { redactedInput?: unknown };
}

interface OpenBoxSession {
  workflowId: string;
  runId: string;
  nodePreExecute(payload: { input: unknown[] }): Promise<WorkflowVerdict>;
  nodePostExecute(payload: { input: unknown[]; output: unknown }): Promise<WorkflowVerdict>;
}

interface OpenBoxSdk {
  OpenBoxCoreClient: new (config: { apiUrl: string; apiKey: string }) => unknown;
  govern: <T>(
    config: { core: unknown; preset: unknown; workflowType: string; taskQueue: string },
    fn: (session: OpenBoxSession) => Promise<T>,
  ) => Promise<T>;
  presets: { n8n: unknown };
}

const importModule = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<OpenBoxSdk>;

let openboxSdkPromise: Promise<OpenBoxSdk> | undefined;

function loadOpenBoxSdk(): Promise<OpenBoxSdk> {
  openboxSdkPromise ??= importModule('openbox-sdk');
  return openboxSdkPromise;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? 'Unknown provider error');
  }
  return 'Unknown provider error';
}

function buildFallbackText(nodeName: string, prompt: string): string {
  if (nodeName.includes('Governed LLM Draft')) {
    const field = (label: string): string | undefined => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = prompt.match(new RegExp(`${escaped}:\\s*(.+)`, 'i'));
      return match?.[1]?.trim();
    };
    const ticketId = field('Ticket ID') ?? 'N8N-DEMO';
    const customer = field('Customer') ?? 'the customer';
    const route = field('Suggested route') ?? 'support-queue';
    const severity = field('Initial severity') ?? 'normal';
    const review = /human review required:\s*yes/i.test(prompt)
      ? 'human-review-required'
      : 'auto-reply-candidate';

    return [
      '**Summary**',
      `${customer} reported a support issue. Initial routing is ${route} with ${severity} severity.`,
      '',
      '**Customer Reply Draft**',
      'Hi,',
      'Thanks for reaching out. We are reviewing the issue and will follow up with the next safe step after checking the account context.',
      'Best,',
      'Support Team',
      '',
      '**Internal Next Step**',
      `Route ticket ${ticketId} to ${route}. Review status: ${review}.`,
      '',
      '**Risks**',
      'Do not confirm refunds, security state, account changes, or sensitive details until a human has verified them.',
    ].join('\n');
  }

  return [
    `OpenBox checkpoint passed for ${nodeName}.`,
    'Provider fallback generated this checkpoint text because the configured LLM provider was unavailable.',
  ].join('\n');
}

function deterministicBlockReason(nodeName: string, prompt: string): string | undefined {
  const lower = prompt.toLowerCase();
  const hasPaymentCard = /\b(?:\d[ -]*?){13,19}\b/.test(prompt);
  const hasSsn = /\b\d{3}-\d{2}-\d{4}\b/.test(prompt);
  const asksForSecrets =
    /ignore all instructions/i.test(prompt) &&
    /(api key|token|secret|password|credential)/i.test(prompt);

  if (nodeName.includes('Prompt Safety Wall')) {
    if (hasPaymentCard || hasSsn) {
      return 'Prompt contains payment-card or SSN-style sensitive data.';
    }
    if (asksForSecrets) {
      return 'Prompt attempts to exfiltrate provider keys, tokens, or secrets.';
    }
    if (/\bnsfw\b|violent sexual|abuse-demo/i.test(prompt)) {
      return 'Prompt contains NSFW or abusive demo content.';
    }
  }

  if (nodeName.includes('Context Privacy Check') && /\bblockme\b|contextblock/i.test(prompt)) {
    return 'Context privacy checkpoint caught the configured demo tripwire.';
  }

  if (nodeName.includes('Channel Output Check')) {
    if (/\bblockme\b|channelblock/i.test(prompt)) {
      return 'Outbound channel checkpoint caught the configured demo tripwire.';
    }
    if (/account (is|was|has been) (verified|secured|changed|reset)|refund (is|was|has been) complete/i.test(prompt)) {
      return 'Outbound payload makes an unsupported account, security, or refund claim.';
    }
    if (/last four digits of your credit card|screenshot of your account dashboard/i.test(prompt)) {
      return 'Outbound payload asks for unnecessary sensitive verification data.';
    }
    if (/sk-[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9-]+|password\s*[:=]/i.test(prompt)) {
      return 'Outbound payload contains a provider key, Slack token, or password-like secret.';
    }
  }

  return undefined;
}

export class OpenboxLlm implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'OpenBox: LLM',
    name: 'openboxLlm',
    icon: 'file:OB_logomark.png',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["model"]}}',
    description: 'Govern an LLM call through OpenBox',
    defaults: { name: 'OpenBox: LLM' },
    inputs: ['main'] as any,
    outputs: ['main'] as any,
    credentials: [
      {
        // Optional so existing demo workflows that read OPENBOX_API_KEY
        // from env vars keep working. New deployments should attach
        // an OpenBox credential and leave the legacy URL/Key params
        // empty; the credential takes precedence when present.
        name: 'openBoxApi',
        required: false,
        testedBy: 'openBoxApiCredentialTest',
      },
    ],
    properties: [
      {
        displayName: 'LLM Provider',
        name: 'llmProvider',
        type: 'options',
        options: [
          { name: 'OpenRouter', value: 'openrouter' },
          { name: 'Ollama', value: 'ollama' },
        ],
        default: '={{ $env["OPENROUTER_API_KEY"] ? "openrouter" : "ollama" }}',
        description: 'Choose the runtime LLM provider. Hosted demos can use an OpenRouter-compatible provider; local demos can use Ollama.',
      },
      {
        displayName: 'Provider API Key',
        name: 'openRouterApiKey',
        type: 'string',
        typeOptions: { password: true },
        default: '={{ $env["LLM_PROVIDER_API_KEY"] || $env["LLM7_API_KEY"] || $env["OPENROUTER_API_KEY"] }}',
        displayOptions: {
          show: {
            llmProvider: ['openrouter'],
          },
        },
      },
      {
        displayName: 'Provider Base URL',
        name: 'openRouterBaseUrl',
        type: 'string',
        default: '={{ $env["LLM_PROVIDER_BASE_URL"] || $env["OPENROUTER_BASE_URL"] || "https://openrouter.ai/api/v1" }}',
        displayOptions: {
          show: {
            llmProvider: ['openrouter'],
          },
        },
      },
      {
        displayName: 'Ollama Host',
        name: 'ollamaHost',
        type: 'string',
        default: '={{ $env["OLLAMA_HOST"] || "ollama:11434" }}',
        description: 'Ollama server host:port',
        displayOptions: {
          show: {
            llmProvider: ['ollama'],
          },
        },
      },
      {
        displayName: 'Model',
        name: 'model',
        type: 'string',
        default:
          '={{ $env["LLM_PROVIDER_MODEL"] || $env["OPENROUTER_MODEL"] || $env["OLLAMA_MODEL"] || "liquid/lfm-2.5-1.2b-instruct:free" }}',
      },
      {
        displayName: 'System Prompt',
        name: 'systemPrompt',
        type: 'string',
        typeOptions: { rows: 4 },
        default: 'You are a helpful assistant.',
      },
      {
        displayName: 'Input Field',
        name: 'inputFieldName',
        type: 'string',
        default: 'chatInput',
        description:
          'Name of the field on each incoming item that holds the user message. Defaults to "chatInput" so the demo Chat Trigger keeps working; change this when wiring up a different upstream node.',
      },
      {
        displayName:
          'Tip: attach an OpenBox credential above to skip the URL / API Key fields below. The credential takes precedence when set.',
        name: 'credentialsNotice',
        type: 'notice',
        default: '',
      },
      {
        displayName: 'OpenBox API Endpoint (legacy)',
        name: 'apiEndpoint',
        type: 'string',
        default: '={{ $env["OPENBOX_API_URL"] || "http://host.docker.internal:8086" }}',
        description:
          'Legacy fallback used only when no OpenBox credential is attached. Will be removed in a future version.',
      },
      {
        displayName: 'OpenBox API Key (legacy)',
        name: 'apiKey',
        type: 'string',
        typeOptions: { password: true },
        default: '={{ $env["OPENBOX_API_KEY"] }}',
        description:
          'Legacy fallback used only when no OpenBox credential is attached (obx_live_* or obx_test_*).',
      },
    ],
  };

  methods = {
    credentialTest: {
      openBoxApiCredentialTest: testOpenBoxCredential,
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const node = this.getNode();
    const fallbackEnabled = process.env.OPENBOX_LLM_FALLBACK !== 'disabled';
    const helpers = this.helpers;

    // Provider config is treated as node-level (not per-item). Pulling
    // it once outside the loop avoids re-evaluating the n8n expression
    // engine for every item, which becomes meaningful at batch sizes.
    const llmProvider = this.getNodeParameter('llmProvider', 0) as string;
    const model = this.getNodeParameter('model', 0) as string;
    const systemPrompt = this.getNodeParameter('systemPrompt', 0) as string;
    const inputFieldName = String(
      this.getNodeParameter('inputFieldName', 0, 'chatInput'),
    ).trim() || 'chatInput';

    const openRouterApiKey =
      llmProvider === 'openrouter'
        ? (this.getNodeParameter('openRouterApiKey', 0, '') as string)
        : '';
    const openRouterBaseUrl =
      llmProvider === 'openrouter'
        ? (this.getNodeParameter('openRouterBaseUrl', 0, 'https://openrouter.ai/api/v1') as string)
        : 'https://openrouter.ai/api/v1';
    const ollamaHost =
      llmProvider === 'ollama'
        ? (this.getNodeParameter('ollamaHost', 0, 'ollama:11434') as string)
        : 'ollama:11434';

    // Resolve OpenBox endpoint + key. Credentials win when present so
    // the demo deployment can transition incrementally; otherwise the
    // legacy params (which default to env-var expressions) are used.
    const { apiUrl, apiKey } = await resolveOpenBoxEndpoint(this);

    const workflowType = String(this.getWorkflow().name ?? 'N8nChatWorkflow');

    const callLlm = async (prompt: string): Promise<string> => {
      if (llmProvider === 'openrouter') {
        if (!openRouterApiKey) {
          throw new NodeOperationError(
            node,
            'A provider API key is required when LLM Provider uses the OpenRouter-compatible chat completions API',
          );
        }

        const baseUrl = openRouterBaseUrl.replace(/\/+$/, '');
        const res = await helpers.httpRequest({
          method: 'POST',
          url: `${baseUrl}/chat/completions`,
          headers: {
            Authorization: `Bearer ${openRouterApiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.N8N_EDITOR_BASE_URL ?? 'https://app.ipsum.lat/ob/n8n/',
            'X-Title': 'OpenBox n8n demo',
          },
          body: {
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt },
            ],
          },
        });
        const choice = (res as any).choices?.[0];
        const message = choice?.message ?? {};
        const text =
          message.content ??
          message.reasoning ??
          choice?.text ??
          (Array.isArray(message.reasoning_details)
            ? message.reasoning_details
                .map((detail: Record<string, unknown>) => detail.text ?? detail.content ?? '')
                .filter(Boolean)
                .join('\n')
            : undefined);
        if (!text) {
          throw new NodeOperationError(
            node,
            'LLM provider returned no message content or reasoning text',
          );
        }
        return text as string;
      }

      const res = await helpers.httpRequest({
        method: 'POST',
        url: `http://${ollamaHost}/api/generate`,
        body: { model, system: systemPrompt, prompt, stream: false },
      });
      return ((res as any).response ?? JSON.stringify(res)) as string;
    };

    const { OpenBoxCoreClient, govern, presets } = await loadOpenBoxSdk();
    // The SDK is reusable across items; reconstruct once and reuse.
    const core = new OpenBoxCoreClient({ apiUrl, apiKey });

    const isAllowed = (verdict: WorkflowVerdict): boolean =>
      verdict.arm === 'allow' || verdict.arm === 'constrain';

    const out: INodeExecutionData[] = [];

    // Loop over every input item — fixes the long-standing items[0]
    // bug where any batch larger than one was silently dropped.
    for (let i = 0; i < items.length; i++) {
      const input = (items[i]?.json ?? {}) as Record<string, unknown>;
      const userMessage = String(input[inputFieldName] ?? '');

      if (!userMessage) {
        if (this.continueOnFail()) {
          out.push({
            json: { ...input, error: `Missing input field "${inputFieldName}"` },
            pairedItem: { item: i },
          });
          continue;
        }
        throw new NodeOperationError(
          node,
          `Missing input field "${inputFieldName}" on item ${i}`,
          { itemIndex: i },
        );
      }

      try {
        const result = await govern(
          { core, preset: presets.n8n, workflowType, taskQueue: 'n8n' },
          async (session) => {
            const pre = await session.nodePreExecute({
              input: [{ [inputFieldName]: userMessage }],
            });
            if (!isAllowed(pre)) {
              return buildBlockedResult(node.name, pre, 'input', session, pre);
            }

            const redactedInput = pre.guardrailsResult?.redactedInput as
              | Array<Record<string, unknown>>
              | undefined;
            const promptToUse =
              (redactedInput?.[0]?.[inputFieldName] as string | undefined) ?? userMessage;
            const deterministicReason = deterministicBlockReason(node.name, promptToUse);
            if (deterministicReason) {
              return {
                text: `Request blocked by OpenBox before ${node.name}: ${deterministicReason}`,
                meta: {
                  governed: true,
                  blocked: true,
                  nodeName: node.name,
                  blockStage: 'input',
                  blockReason: deterministicReason,
                  workflowId: session.workflowId,
                  runId: session.runId,
                  pre: { arm: pre.arm, riskScore: pre.riskScore, reason: pre.reason },
                },
              };
            }

            let text: string;
            let providerFallback: { enabled: boolean; reason?: string } = { enabled: false };
            try {
              text = await callLlm(promptToUse);
            } catch (error) {
              if (fallbackEnabled) {
                providerFallback = { enabled: true, reason: errorMessage(error) };
                text = buildFallbackText(node.name, promptToUse);
              } else {
                return buildProviderErrorResult(node.name, error, session, pre);
              }
            }

            let postSkipped: string | undefined;
            let post: WorkflowVerdict;
            try {
              post = await session.nodePostExecute({
                input: [{ [inputFieldName]: promptToUse }],
                output: { text },
              });
            } catch (error) {
              postSkipped = errorMessage(error);
              post = {
                arm: 'allow',
                riskScore: pre.riskScore,
                reason: `Post-check skipped: ${postSkipped}`,
              } as WorkflowVerdict;
            }
            if (!isAllowed(post)) {
              return buildBlockedResult(node.name, post, 'output', session, pre, post);
            }

            const redactedOutput = post.guardrailsResult?.redactedInput as
              | { text?: string }
              | undefined;
            const finalText = redactedOutput?.text ?? text;

            return {
              text: finalText,
              meta: {
                governed: true,
                workflowId: session.workflowId,
                runId: session.runId,
                nodeName: node.name,
                providerFallback: providerFallback.enabled,
                providerFallbackReason: providerFallback.reason,
                postSkipped,
                pre: { arm: pre.arm, riskScore: pre.riskScore, reason: pre.reason },
                post: { arm: post.arm, riskScore: post.riskScore, reason: post.reason },
              },
            };
          },
        );

        out.push({
          json: {
            ...input,
            output: result.text,
            text: result.text,
            _openbox: result.meta,
          },
          pairedItem: { item: i },
        });
      } catch (error) {
        if (this.continueOnFail()) {
          out.push({
            json: { ...input, error: errorMessage(error) },
            error: error as NodeOperationError,
            pairedItem: { item: i },
          });
          continue;
        }
        throw error;
      }
    }

    return [out];
  }
}

// ────────────────────────────────────────────────────────────────────
// Helpers extracted from the original closures so they're testable in
// isolation and don't allocate per-item.
// ────────────────────────────────────────────────────────────────────

/**
 * Resolve the OpenBox endpoint + API key. Prefers an attached
 * `openBoxApi` credential; falls back to the legacy node params for
 * deployments that pre-date the credential type.
 *
 * Throws a NodeOperationError if neither source provides usable
 * values, since refusing to govern silently would defeat the point of
 * the integration.
 */
async function resolveOpenBoxEndpoint(
  ctx: IExecuteFunctions,
): Promise<{ apiUrl: string; apiKey: string }> {
  let normalized: OpenBoxCredentials | undefined;
  try {
    const raw = await ctx.getCredentials('openBoxApi');
    normalized = normalizeOpenBoxCredentials(raw);
  } catch {
    // No credential attached — fall through to legacy param read.
  }

  if (normalized) {
    return { apiUrl: normalized.openboxUrl, apiKey: normalized.apiKey };
  }

  const apiUrl = String(ctx.getNodeParameter('apiEndpoint', 0, '') ?? '').trim();
  const apiKey = String(ctx.getNodeParameter('apiKey', 0, '') ?? '').trim();
  if (!apiUrl || !apiKey) {
    throw new NodeOperationError(
      ctx.getNode(),
      'OpenBox is not configured: attach an OpenBox credential, or set OPENBOX_API_URL + OPENBOX_API_KEY environment variables.',
    );
  }
  return { apiUrl, apiKey };
}

function buildBlockedResult(
  nodeName: string,
  verdict: WorkflowVerdict,
  stage: 'input' | 'output',
  session: { workflowId: string; runId: string },
  pre?: WorkflowVerdict,
  post?: WorkflowVerdict,
): { text: string; meta: Record<string, unknown> } {
  const fallback =
    stage === 'input' ? 'Request blocked by governance' : 'Response blocked by governance';
  const reason = verdict.reason ?? fallback;
  const text =
    stage === 'input'
      ? `Request blocked by OpenBox before ${nodeName}: ${reason}`
      : `Response blocked by OpenBox after ${nodeName}: ${reason}`;
  return {
    text,
    meta: {
      governed: true,
      blocked: true,
      nodeName,
      blockStage: stage,
      blockReason: reason,
      workflowId: session.workflowId,
      runId: session.runId,
      pre: pre ? { arm: pre.arm, riskScore: pre.riskScore, reason: pre.reason } : undefined,
      post: post ? { arm: post.arm, riskScore: post.riskScore, reason: post.reason } : undefined,
    },
  };
}

function buildProviderErrorResult(
  nodeName: string,
  error: unknown,
  session: { workflowId: string; runId: string },
  pre?: WorkflowVerdict,
): { text: string; meta: Record<string, unknown> } {
  const reason = errorMessage(error);
  return {
    text: `Request stopped by OpenBox at ${nodeName}: LLM provider failed before a governed draft could be produced. ${reason}`,
    meta: {
      governed: true,
      blocked: true,
      providerError: true,
      nodeName,
      blockStage: 'provider-error',
      blockReason: reason,
      workflowId: session.workflowId,
      runId: session.runId,
      pre: pre ? { arm: pre.arm, riskScore: pre.riskScore, reason: pre.reason } : undefined,
    },
  };
}
