/* eslint-disable @n8n/community-nodes/require-node-api-error */
import {
  IExecuteFunctions,
  IHookFunctions,
  IHttpRequestMethods,
  IHttpRequestOptions,
  IWebhookFunctions,
  JsonObject,
  NodeApiError,
} from 'n8n-workflow';

import {
  OpenBoxCredentials,
  normalizeOpenBoxCredentials,
} from '../credentials/OpenBoxApi.credentials';
import { buildSignedHeaders, serializeBody } from './signing';

const OPENBOX_TIMEOUT_MS = 35_000;

type RequestContext = IExecuteFunctions | IWebhookFunctions | IHookFunctions;

export interface OpenBoxRequestOptions {
  method: IHttpRequestMethods;
  /** Path beginning with "/", appended to the OpenBox base URL. */
  path: string;
  body?: unknown;
  qs?: Record<string, string | number | boolean | undefined>;
  noRetry?: boolean;
  traceId?: string;
}

export async function getOpenBoxCredentials(
  ctx: RequestContext,
): Promise<OpenBoxCredentials> {
  try {
    const raw = await ctx.getCredentials('openBoxApi');
    if (raw && raw.apiKey) {
      return normalizeOpenBoxCredentials(raw);
    }
  } catch {
    // Credential not attached — fall through to env-var path
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _env: Record<string, string | undefined> = (global as any).process?.env ?? {};
  const envKey = _env.OPENBOX_API_KEY ?? '';
  if (!envKey) {
    throw new NodeApiError(ctx.getNode(), {
      message: 'OpenBox API key not set',
      description:
        'Attach an OpenBox credential to this node, or set OPENBOX_API_KEY in the environment.',
    } as JsonObject);
  }
  return {
    openboxUrl: (_env.OPENBOX_API_URL ?? 'https://core.openbox.ai').replace(/\/+$/, ''),
    apiKey: envKey,
    agentDid: _env.OPENBOX_AGENT_DID || undefined,
    agentPrivateKey: _env.OPENBOX_AGENT_PRIVATE_KEY || undefined,
  };
}

export async function openboxRequest<T = unknown>(
  ctx: RequestContext,
  options: OpenBoxRequestOptions,
): Promise<T> {
  const credentials = await getOpenBoxCredentials(ctx);

  const url = `${credentials.openboxUrl}${options.path}`;

  // Serialize body before signing so the bytes we hash == the bytes we send.
  const bodyBytes = serializeBody(options.body ?? null);

  const headers = buildSignedHeaders(
    options.method,
    options.path,
    bodyBytes,
    credentials.apiKey,
    credentials.agentDid,
    credentials.agentPrivateKey,
  );

  if (options.traceId) {
    headers['X-OpenBox-Trace-Id'] = options.traceId;
  }

  const requestOptions: IHttpRequestOptions = {
    method: options.method,
    url,
    headers,
    json: false,
    timeout: OPENBOX_TIMEOUT_MS,
    body: bodyBytes.length > 0 ? (bodyBytes as unknown as IHttpRequestOptions['body']) : undefined,
    qs: options.qs as IHttpRequestOptions['qs'],
    returnFullResponse: false,
    ignoreHttpStatusErrors: false,
  };

  try {
    const raw = await ctx.helpers.httpRequest(requestOptions);
    if (typeof raw === 'string') return JSON.parse(raw) as T;
    if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString('utf-8')) as T;
    return raw as T;
  } catch (err) {
    throw new SoftGovernanceError(
      err instanceof Error ? err.message : String(err),
      err,
    );
  }
}

/**
 * Marker error for governance/network failures. Callers that can safely
 * continue (fail-open) catch this; callers that must fail hard re-throw it
 * as a NodeApiError.
 */
export class SoftGovernanceError extends Error {
  public readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'SoftGovernanceError';
    this.cause = cause;
  }
}
