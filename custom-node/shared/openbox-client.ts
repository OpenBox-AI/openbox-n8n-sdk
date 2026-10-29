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
import { addIgnoredPrefix } from './ignored-urls';
import { buildSignedHeaders, serializeBody } from './signing';
import {
  WORKLOAD_TOKEN_HEADER,
  WorkloadHttp,
  WorkloadIdentityError,
  getWorkloadAuth,
  invalidateWorkloadToken,
} from './workload-identity';

const OPENBOX_TIMEOUT_MS = 35_000;

type RequestContext = IExecuteFunctions | IWebhookFunctions | IHookFunctions;

/** Core's v1 paths and their v3 (workload identity) counterparts. */
const V3_PATHS: Record<string, string> = {
  '/api/v1/governance/evaluate': '/api/v3/governance/evaluate',
  '/api/v1/governance/approval': '/api/v3/governance/approval',
  '/api/v1/auth/validate': '/api/v3/auth/validate',
};

/** n8n's request helper as the raw transport for the workload bootstrap and token exchange. */
export function workloadHttpFor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  helpers: { httpRequest: (options: IHttpRequestOptions) => Promise<any> },
  timeoutMs: number,
): WorkloadHttp {
  return async ({ method, url, headers, body }) => {
    const response = await helpers.httpRequest({
      method,
      url,
      headers,
      body,
      json: false,
      timeout: timeoutMs,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
    });
    const raw = (response as { body?: unknown } | null)?.body;
    const text =
      typeof raw === 'string' ? raw
        : Buffer.isBuffer(raw) ? raw.toString('utf-8')
          : raw == null ? ''
            : JSON.stringify(raw);
    return { status: Number((response as { statusCode?: number } | null)?.statusCode ?? 0), body: text };
  };
}

/**
 * Map a workload-identity failure onto the client's error contract: network
 * trouble follows onApiError like any outage; a rejected or misconfigured
 * identity always fails closed.
 */
export function toGovernanceError(err: WorkloadIdentityError): Error {
  if (err.kind === 'network') return new SoftGovernanceError(err.message, err);
  return new GovernanceAuthError(err.message, err.statusCode ?? 0, err);
}

export interface OpenBoxRequestOptions {
  method: IHttpRequestMethods;
  /** Path beginning with "/", appended to the OpenBox base URL. */
  path: string;
  body?: unknown;
  qs?: Record<string, string | number | boolean | undefined>;
  traceId?: string;
  /** Overrides OPENBOX_TIMEOUT_MS — sourced from GovernanceConfig.governanceTimeout. */
  timeoutMs?: number;
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
    // fall through
  }

  throw new NodeApiError(ctx.getNode(), {
    message: 'OpenBox API key not set',
    description: 'Attach an OpenBox credential to this node.',
  } as JsonObject);
}

export async function openboxRequest<T = unknown>(
  ctx: RequestContext,
  options: OpenBoxRequestOptions,
): Promise<T> {
  const credentials = await getOpenBoxCredentials(ctx);
  const timeoutMs = options.timeoutMs ?? OPENBOX_TIMEOUT_MS;

  // Serialize body before signing so the bytes we hash == the bytes we send.
  const bodyBytes = serializeBody(options.body ?? null);

  // v3 workload identity when the credential carries a workload key and Core
  // has an authority for the agent; otherwise the legacy v1 path (DID-signed
  // when a DID is configured).
  let workloadToken: string | null = null;
  let path = options.path;
  if (credentials.workloadPrivateKey && V3_PATHS[options.path]) {
    try {
      const auth = await getWorkloadAuth(
        workloadHttpFor(ctx.helpers, timeoutMs),
        {
          apiUrl: credentials.openboxUrl,
          apiKey: credentials.apiKey,
          privateKeyPem: credentials.workloadPrivateKey,
          coreHeaders: buildSignedHeaders('GET', '/api/v3/auth/bootstrap', Buffer.alloc(0), credentials.apiKey),
        },
        (document) => addIgnoredPrefix(document.issuer),
      );
      if (auth) {
        workloadToken = auth.token;
        path = V3_PATHS[options.path];
      }
    } catch (err) {
      if (err instanceof WorkloadIdentityError) throw toGovernanceError(err);
      throw err;
    }
  }

  const url = `${credentials.openboxUrl}${path}`;
  const headers = workloadToken != null
    ? {
      ...buildSignedHeaders(options.method, path, bodyBytes, credentials.apiKey),
      [WORKLOAD_TOKEN_HEADER]: workloadToken,
    }
    : buildSignedHeaders(
      options.method,
      path,
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
    timeout: timeoutMs,
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
    const statusCode = extractHttpStatusCode(err);
    if (statusCode === 401 || statusCode === 403) {
      // Auth/signing failures always hard-fail, regardless of onApiError —
      // a revoked/invalid key must never silently degrade to "run ungoverned".
      // On v3 the token this request carried is discarded (Core does not tell
      // an expired token from a changed authority) and the request is not
      // replayed; the next one bootstraps again.
      if (workloadToken != null && credentials.workloadPrivateKey) {
        invalidateWorkloadToken(
          { apiUrl: credentials.openboxUrl, apiKey: credentials.apiKey, privateKeyPem: credentials.workloadPrivateKey },
          workloadToken,
        );
      }
      throw new GovernanceAuthError(
        err instanceof Error ? err.message : String(err),
        statusCode,
        err,
      );
    }
    throw new SoftGovernanceError(
      err instanceof Error ? err.message : String(err),
      err,
    );
  }
}

/**
 * Best-effort extraction of an HTTP status code from whatever shape n8n's
 * httpRequest helper (or an upstream NodeApiError) throws. Different n8n
 * versions/transports surface this differently, so several paths are tried.
 */
function extractHttpStatusCode(err: unknown): number | null {
  if (err == null || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;
  const candidates: unknown[] = [
    e.statusCode,
    e.httpCode,
    (e.response as Record<string, unknown> | undefined)?.statusCode,
    (e.response as Record<string, unknown> | undefined)?.status,
    (e.cause as Record<string, unknown> | undefined)?.statusCode,
    ((e.cause as Record<string, unknown> | undefined)?.response as Record<string, unknown> | undefined)?.status,
  ];
  for (const c of candidates) {
    const n = typeof c === 'string' ? Number(c) : c;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
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

/**
 * A 401/403 from Core. Always a hard failure — never caught as fail-open,
 * regardless of the configured onApiError policy.
 */
export class GovernanceAuthError extends Error {
  public readonly statusCode: number;
  public readonly cause: unknown;
  constructor(message: string, statusCode: number, cause: unknown) {
    super(message);
    this.name = 'GovernanceAuthError';
    this.statusCode = statusCode;
    this.cause = cause;
  }
}
