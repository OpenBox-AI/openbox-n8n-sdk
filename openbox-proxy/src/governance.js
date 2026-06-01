/**
 * Governance client for the OpenBox proxy. Wraps a single POST to
 * `/api/v1/governance/evaluate` and normalizes the verdict shape so
 * the rest of the proxy doesn't have to care about snake_case vs
 * camelCase or v1.0 vs v1.1 envelopes.
 */

'use strict';

const { log } = require('./logger');

const apiUrl = (process.env.OPENBOX_API_URL || '').replace(/\/+$/, '');
const apiKey = process.env.OPENBOX_API_KEY || '';
const timeoutMs = Number(process.env.OPENBOX_PROXY_TIMEOUT_MS || 5000);

if (!apiUrl || !apiKey) {
  log.warn(
    'OPENBOX_API_URL and OPENBOX_API_KEY are not set; the proxy will fail every evaluate() call.',
  );
}

/**
 * Submit a request descriptor to OpenBox and return the verdict.
 * Throws on transport errors so the caller can apply its fail-open
 * vs fail-closed policy explicitly.
 */
async function evaluate(request) {
  if (!apiUrl || !apiKey) {
    throw new Error('OpenBox proxy not configured (OPENBOX_API_URL / OPENBOX_API_KEY missing)');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiUrl}/api/v1/governance/evaluate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-OpenBox-Source': 'n8n-governance-proxy',
      },
      body: JSON.stringify({
        // Mirror the community node's evaluate envelope so the
        // dashboard treats proxy-side checkpoints identically to
        // explicit OpenBox node calls.
        workflow_id: 'n8n-proxy',
        workflow_type: 'n8n.ProxiedRequest',
        task_queue: 'n8n',
        event_type: 'ActivityStarted',
        activity_type: `${request.method} ${maskUrl(request.url)}`,
        activity_stage: 'pre',
        payload: { input: [request] },
        metadata: { source: 'n8n-governance-proxy' },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`evaluate ${res.status}: ${text || res.statusText}`);
    }

    const json = await res.json();
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decide whether a verdict represents an "allowed" outcome. Mirrors
 * the SDK's `WorkflowVerdict.arm` semantics: only `allow` and
 * `constrain` should pass through the proxy. Everything else
 * (block, halt, require_approval) results in a 403.
 */
function allowedVerdict(verdict) {
  if (!verdict || typeof verdict !== 'object') return false;
  const arm = verdict.arm || verdict.action || verdict.verdict;
  return arm === 'allow' || arm === 'constrain';
}

/**
 * Strip query strings and credentials from a URL before logging /
 * sending it as part of an activity_type. Avoids accidentally
 * fingerprinting a secret in the OpenBox dashboard.
 */
function maskUrl(url) {
  if (!url) return 'unknown';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return String(url).split('?')[0];
  }
}

/**
 * Submit a post-request observability span (Phase 3 body capture).
 * Best-effort fire-and-forget — never throws so a span failure
 * cannot affect the response the client already received.
 */
async function submitSpan(span) {
  if (!apiUrl || !apiKey || !span) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`${apiUrl}/api/v1/governance/spans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-OpenBox-Source': 'n8n-governance-proxy',
      },
      body: JSON.stringify({ source: 'n8n-governance-proxy', ...span }),
      signal: controller.signal,
    });
  } catch {
    /* best-effort — silently drop on network error */
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { evaluate, allowedVerdict, maskUrl, submitSpan };
