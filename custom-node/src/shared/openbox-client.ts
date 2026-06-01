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

/**
 * Anything in n8n's runtime that exposes `getCredentials` and
 * `helpers.httpRequest`. Keeping the contract minimal so the same
 * helper can be reused from execute(), webhook(), and lifecycle hooks.
 */
type RequestContext = IExecuteFunctions | IWebhookFunctions | IHookFunctions;

export interface OpenBoxRequestOptions {
  method: IHttpRequestMethods;
  /** Path beginning with "/", appended to the credential's openboxUrl. */
  path: string;
  body?: unknown;
  qs?: Record<string, string | number | boolean | undefined>;
  /**
   * When true, the request bypasses retries and surfaces the upstream
   * error verbatim. Used by `evaluate` because each retry creates a
   * new workflow on the OpenBox side.
   */
  noRetry?: boolean;
  /**
   * Adds a per-request `X-OpenBox-Trace-Id` so a workflow execution
   * can be correlated end-to-end across multiple node calls.
   */
  traceId?: string;
}

/**
 * Resolve OpenBox credentials. Falls back to environment variables when no
 * credential is attached (matching openboxLlm / Temporal SDK behaviour where
 * OPENBOX_API_KEY and OPENBOX_API_URL are the primary config path).
 */
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

  // Env-var fallback: mirrors the Temporal SDK's OPENBOX_API_KEY / OPENBOX_API_URL
  const envKey = process.env.OPENBOX_API_KEY ?? '';
  const envUrl = (process.env.OPENBOX_API_URL ?? 'https://core.openbox.ai').replace(/\/+$/, '');
  if (!envKey) {
    throw new NodeApiError(ctx.getNode(), {
      message: 'OpenBox API key not set',
      description:
        'Attach an OpenBox credential to this node, or set OPENBOX_API_KEY in the environment.',
    } as JsonObject);
  }
  return {
    openboxUrl: envUrl,
    apiKey: envKey,
    environment: 'production',
    timeoutMs: 35_000,
    failPolicy: 'fail_open',
    enforceHttps: false,
    agentDid: process.env.OPENBOX_AGENT_DID || undefined,
    agentPrivateKey: process.env.OPENBOX_AGENT_PRIVATE_KEY || undefined,
  };
}

/**
 * Make an authenticated request to the OpenBox Core API. Handles
 * scoping headers, timeout, and the `failPolicy` toggle. Errors
 * thrown from this helper are already shaped as NodeApiError so the
 * caller can re-throw without further wrapping.
 *
 * Note: we intentionally do NOT route through the OpenBoxCoreClient
 * here because the SDK client constructs its own retry/backoff and
 * doesn't accept the credentialed httpRequest helper. Going through
 * n8n's `helpers.httpRequest` keeps requests visible in the executions
 * UI and respects the credential's encrypted secrets.
 */
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

  if (credentials.organizationId) {
    headers['X-OpenBox-Organization'] = credentials.organizationId;
  }
  if (credentials.projectId) {
    headers['X-OpenBox-Project'] = credentials.projectId;
  }
  if (options.traceId) {
    headers['X-OpenBox-Trace-Id'] = options.traceId;
  }

  // Always use json: false so we control the exact bytes on the wire.
  // n8n with json:true would re-serialize the body object, changing the bytes
  // and breaking the body-hash in the AIP signature. We parse the JSON response
  // ourselves after the call.
  const requestOptions: IHttpRequestOptions = {
    method: options.method,
    url,
    headers,
    json: false,
    timeout: credentials.timeoutMs,
    body: bodyBytes.length > 0 ? (bodyBytes as unknown as IHttpRequestOptions['body']) : undefined,
    qs: options.qs as IHttpRequestOptions['qs'],
    returnFullResponse: false,
    ignoreHttpStatusErrors: false,
  };

  try {
    const raw = await ctx.helpers.httpRequest(requestOptions);
    // n8n returns a string or Buffer when json: false — parse it ourselves.
    if (typeof raw === 'string') return JSON.parse(raw) as T;
    if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString('utf-8')) as T;
    return raw as T;
  } catch (err) {
    if (credentials.failPolicy === 'fail_open') {
      // Surface a structured "soft failure" so callers can decide
      // whether to keep going. We deliberately do NOT swallow the
      // error inside the helper itself; the caller knows whether the
      // operation was safe to skip.
      throw new SoftGovernanceError(
        err instanceof Error ? err.message : String(err),
        err,
      );
    }
    throw new NodeApiError(ctx.getNode(), err as JsonObject, {
      message: `OpenBox API request failed: ${options.method} ${options.path}`,
    });
  }
}

/**
 * Marker error raised when `failPolicy === 'fail_open'` so callers can
 * distinguish a network/governance outage from a legitimate block
 * verdict. The original error is kept on `.cause` for diagnostics.
 */
export class SoftGovernanceError extends Error {
  public readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'SoftGovernanceError';
    this.cause = cause;
  }
}
