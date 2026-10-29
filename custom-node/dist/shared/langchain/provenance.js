"use strict";
/**
 * Routing provenance: which provider actually served each model call.
 *
 * OpenRouter's pitch to its users is two promises that pull against each
 * other. One is trust — "ensure prompts only go to the models and providers
 * you trust". The other is reliability — 80+ providers with automatic
 * fallback when one goes down. Together they mean the provider that serves a
 * given call is decided at request time, per call, and the caller cannot see
 * which one it was. A dashboard aggregate is not evidence, and "we routed it
 * correctly" is exactly the kind of claim a regulated buyer cannot accept on
 * faith.
 *
 * OpenRouter does publish the answer: `GET /api/v1/generation?id=<gen-id>`
 * returns the provider that served the request, the region it was processed
 * in, what it cost, whether a key of yours was used, and — when a provider
 * failed — the fallback attempts that preceded it. This module reads that
 * record for every governed model call so OpenBox can do three things with
 * it that OpenRouter alone cannot:
 *
 *   1. **Enforce** it. The record lands on a span, so a policy can refuse a
 *      call served outside an approved provider set or region.
 *   2. **Attest** it. The record travels in span attributes, which are what
 *      Core hashes into the session's Merkle tree — so it is sealed under the
 *      signed session root and cannot be edited after the fact.
 *   3. **Check the promise.** The routing the caller ASKED for travels with
 *      it, so "only anthropic" versus what actually served the call is a
 *      comparison anyone can make, not a claim they have to believe.
 *
 * Reading the record costs one HTTP call per model call, made after the model
 * call has already returned, so it is never on the critical path of the
 * answer. Without an OpenRouter key it is silently off.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractRequestedRouting = extractRequestedRouting;
exports.readRequestedRouting = readRequestedRouting;
exports.isRoutingHonored = isRoutingHonored;
exports.extractRequestedModel = extractRequestedModel;
exports.readRequestedModel = readRequestedModel;
exports.isModelHonored = isModelHonored;
exports.normalizeGenerationRecord = normalizeGenerationRecord;
exports.recordFromResponse = recordFromResponse;
exports.fetchGenerationRecord = fetchGenerationRecord;
exports.provenanceAttributes = provenanceAttributes;
// setTimeout via require, as elsewhere in this package (n8n's community-node
// lint restricts the bare global).
const _timersMod = 'timers';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setTimeout: _setTimeout, clearTimeout: _clearTimeout } = require(_timersMod);
const residency_1 = require("./residency");
const GENERATION_PATH = '/api/v1/generation';
/**
 * Read the routing constraints out of a request body.
 *
 * These are the caller's own words about where their prompt may go, which is
 * the half of the comparison OpenRouter's record cannot supply.
 */
function extractRequestedRouting(requestBody) {
    if (requestBody == null)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(requestBody);
    }
    catch {
        return null;
    }
    return readRequestedRouting(parsed);
}
/**
 * Read the routing constraints straight off the request OBJECT.
 *
 * The body-based reader above only sees a request whose body was captured, and
 * capture is opt-in for `Request` objects — cloning one destabilised the
 * OpenRouter client's retry path, so `captureRequestObjectBody` defaults to
 * false. That left the honored comparison silently inert for the very client
 * this SDK exists to govern: the constraint was sent and obeyed, and the
 * evidence recorded `unconstrained`.
 *
 * Reading the object the caller handed to `callModel` needs no clone and no
 * capture, so it works regardless of that setting.
 */
function readRequestedRouting(request) {
    if (request == null || typeof request !== 'object')
        return null;
    const body = request;
    const routing = {};
    const provider = body.provider;
    if (provider != null && typeof provider === 'object') {
        const p = provider;
        if (Array.isArray(p.only))
            routing.only = p.only.map(String);
        if (Array.isArray(p.order))
            routing.order = p.order.map(String);
        if (typeof p.allow_fallbacks === 'boolean')
            routing.allowFallbacks = p.allow_fallbacks;
    }
    if (Array.isArray(body.models))
        routing.models = body.models.map(String);
    return Object.keys(routing).length > 0 ? routing : null;
}
/** Provider names are compared case-insensitively; OpenRouter mixes casing. */
function sameProvider(a, b) {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}
/**
 * Was the serving provider inside what the caller asked for?
 *
 * Only `only` is a hard constraint. `order` is a preference — being served by
 * something outside it is not a broken promise, so it does not fail the check.
 */
function isRoutingHonored(provider, requested) {
    if (requested?.only == null || requested.only.length === 0)
        return null;
    if (provider == null)
        return null;
    return requested.only.some((allowed) => sameProvider(allowed, provider));
}
/**
 * Read the model the caller asked for, off a request body.
 *
 * Kept separate from `RequestedRouting` on purpose: that type is also the
 * shape a policy injects back INTO a request (`applyRoutingToRequest`), and a
 * governance layer that can silently rewrite which model runs is a different,
 * much larger claim than one that checks it. This is read-only evidence.
 */
function extractRequestedModel(requestBody) {
    if (requestBody == null)
        return null;
    try {
        return readRequestedModel(JSON.parse(requestBody));
    }
    catch {
        return null;
    }
}
/** Read the requested model straight off the request OBJECT. */
function readRequestedModel(request) {
    if (request == null || typeof request !== 'object')
        return null;
    return asString(request.model);
}
/**
 * Compare two OpenRouter model ids.
 *
 * Variant suffixes (`:floor`, `:nitro`, `:online`) select how a model is
 * routed, not which model runs, and OpenRouter reports the base id back — so
 * `openai/gpt-4o-mini:floor` served as `openai/gpt-4o-mini` is not a
 * substitution. Everything else is compared literally: `gpt-4o-mini` and
 * `gpt-4o` are different products at different prices, and a comparison
 * generous enough to call them equal would defeat the check.
 */
function sameModel(a, b) {
    const base = (id) => id.trim().toLowerCase().split(':')[0];
    return base(a) === base(b);
}
/** `openrouter/auto` and friends delegate the choice — nothing is promised. */
function isAutoRouted(model) {
    return model.trim().toLowerCase().endsWith('/auto');
}
/**
 * Did the model that ran match the model that was asked for?
 *
 * "Did I get the model I paid for?" is the router fear this answers. The
 * response body carries the model as the provider ran it, but nobody compares
 * it to the request — and under a `models` fallback chain, or a provider that
 * quietly serves a quantized or older build, the two can differ while the call
 * looks entirely successful.
 *
 * A model named in the caller's own `models` fallback chain counts as honored:
 * they asked for it as an acceptable alternative. Anything else does not.
 */
function isModelHonored(served, requested, fallbacks) {
    if (requested == null || requested.trim() === '')
        return null;
    if (isAutoRouted(requested))
        return null;
    if (served == null)
        return null;
    if (sameModel(served, requested))
        return true;
    return (fallbacks ?? []).some((candidate) => sameModel(candidate, served));
}
function asNumber(value) {
    const n = typeof value === 'string' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
function asString(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}
/** Normalize OpenRouter's generation record, tolerating fields it may omit. */
function normalizeGenerationRecord(generationId, raw, requested, requestedModel = null, residency = null) {
    const root = (raw != null && typeof raw === 'object' ? raw : {});
    // The endpoint wraps the record in `data`.
    const record = (root.data != null && typeof root.data === 'object'
        ? root.data
        : root);
    const attempts = [];
    const responses = record.provider_responses;
    if (Array.isArray(responses)) {
        for (const entry of responses) {
            if (entry == null || typeof entry !== 'object')
                continue;
            const e = entry;
            attempts.push({
                provider: asString(e.provider_name) ?? asString(e.provider) ?? undefined,
                status: (asNumber(e.status) ?? asString(e.status)) ?? undefined,
                error: asString(e.error) ?? undefined,
                latencyMs: asNumber(e.latency) ?? undefined,
            });
        }
    }
    const provider = asString(record.provider_name);
    const model = asString(record.model);
    const dataRegion = asString(record.data_region);
    const isByok = typeof record.is_byok === 'boolean' ? record.is_byok : null;
    return {
        generationId,
        provider,
        model,
        dataRegion,
        totalCost: asNumber(record.total_cost),
        upstreamCost: asNumber(record.upstream_inference_cost),
        tokensPrompt: asNumber(record.tokens_prompt),
        tokensCompletion: asNumber(record.tokens_completion),
        latencyMs: asNumber(record.latency),
        finishReason: asString(record.finish_reason),
        isByok,
        attempts,
        requested,
        honored: isRoutingHonored(provider, requested),
        requestedModel,
        modelHonored: isModelHonored(model, requestedModel, requested?.models),
        residency,
        regionHonored: (0, residency_1.isRegionApproved)(dataRegion, residency),
        ownKeyHonored: (0, residency_1.isOwnKeyHonored)(isByok, residency),
    };
}
/**
 * Provenance read off the model response itself, for when OpenRouter's
 * generation record has not been published in time (it can lag the response
 * by half a minute). The response carries the generation id, the model and
 * provider that served it, token usage and cost; region and fallback attempts
 * exist only in the record. Accepts a JSON body or an SSE stream (the frames'
 * envelope fields, and usage from the last frame that has it).
 */
function recordFromResponse(generationId, responseBody, requested, requestedModel = null) {
    if (responseBody == null)
        return null;
    const frames = [];
    const text = responseBody.trim();
    const tryParse = (raw) => {
        try {
            const parsed = JSON.parse(raw);
            if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                frames.push(parsed);
            }
        }
        catch { /* a partial frame */ }
    };
    if (text.startsWith('{')) {
        tryParse(text);
    }
    else {
        for (const line of text.split(/\r?\n/)) {
            if (line.startsWith('data:'))
                tryParse(line.slice(5).trim());
        }
    }
    if (frames.length === 0)
        return null;
    const pick = (key) => frames.map((f) => f[key]).find((v) => v != null);
    const usage = ([...frames].reverse().map((f) => f.usage).find((u) => u != null && typeof u === 'object') ??
        {});
    const choices = [...frames].reverse().map((f) => f.choices).find((c) => Array.isArray(c) && c.length > 0);
    return normalizeGenerationRecord(generationId, {
        model: pick('model'),
        provider_name: pick('provider'),
        tokens_prompt: usage.prompt_tokens,
        tokens_completion: usage.completion_tokens,
        total_cost: usage.cost,
        finish_reason: choices?.[0]?.finish_reason,
    }, requested, requestedModel);
}
/**
 * Fetch the generation record for one model call.
 *
 * Returns null rather than throwing: provenance is evidence, and failing to
 * collect it must never fail the run that produced it. The record can lag the
 * response by a moment, so a 404 is retried once.
 */
async function fetchGenerationRecord(generationId, requested, opts, requestedModel = null, residency = null) {
    const base = (opts.baseUrl ?? 'https://openrouter.ai').replace(/\/$/, '');
    const url = `${base}${GENERATION_PATH}?id=${encodeURIComponent(generationId)}`;
    const timeoutMs = opts.timeoutMs ?? 4_000;
    // OpenRouter writes the generation record shortly after the response, not
    // with it: measured 404 at +0ms and at +400ms, present a moment later. Since
    // this runs in the background, it can afford to wait properly rather than
    // give up and lose the evidence.
    const backoffMs = opts.backoffMs ?? [300, 700, 1_500, 2_500, 4_000];
    for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
        if (attempt > 0) {
            // Deliberately NOT unref'd. These waits are what keeps the process alive
            // while evidence is still being collected — with them unref'd, Node
            // exited mid-collection and two of three model calls in a run lost their
            // provenance. The schedule is bounded, so this cannot hold a process
            // open indefinitely.
            await new Promise((resolve) => _setTimeout(resolve, backoffMs[attempt - 1]));
        }
        const controller = new AbortController();
        const timer = _setTimeout(() => controller.abort(), timeoutMs);
        timer.unref?.();
        try {
            let init = {
                method: 'GET',
                headers: { authorization: `Bearer ${opts.apiKey}` },
                signal: controller.signal,
            };
            if (opts.markInternal)
                init = opts.markInternal(init);
            const response = await (opts.fetchImpl ?? fetch)(url, init);
            if (response.status === 404)
                continue; // not written yet — try once more
            if (!response.ok)
                return null;
            const body = (await response.json());
            return normalizeGenerationRecord(generationId, body, requested, requestedModel, residency);
        }
        catch {
            continue; // transient — the loop's backoff is the retry
        }
        finally {
            _clearTimeout(timer);
        }
    }
    return null;
}
/**
 * The attested form: flat, stable keys that go into span attributes.
 *
 * Attributes are what Core hashes into the session's Merkle tree, so every
 * key here ends up under the signed session root. Nulls are dropped rather
 * than sent — an absent field and a field asserted to be null are different
 * claims, and only one of them is honest when OpenRouter did not tell us.
 */
function provenanceAttributes(p) {
    const attrs = {
        'gen_ai.generation.id': p.generationId,
    };
    const put = (key, value) => {
        if (value != null)
            attrs[key] = value;
    };
    put('gen_ai.upstream.provider', p.provider);
    put('gen_ai.response.model', p.model);
    put('gen_ai.upstream.data_region', p.dataRegion);
    put('gen_ai.usage.total_cost', p.totalCost);
    put('gen_ai.usage.upstream_cost', p.upstreamCost);
    put('gen_ai.usage.tokens_prompt', p.tokensPrompt);
    put('gen_ai.usage.tokens_completion', p.tokensCompletion);
    put('gen_ai.upstream.latency_ms', p.latencyMs);
    put('gen_ai.response.finish_reason', p.finishReason);
    put('gen_ai.upstream.is_byok', p.isByok);
    if (p.attempts.length > 0) {
        attrs['gen_ai.routing.fallback_attempts'] = p.attempts.length;
        attrs['gen_ai.routing.providers_tried'] = p.attempts
            .map((a) => a.provider)
            .filter((name) => name != null);
        // The full trail, one object per attempt, in the order OpenRouter reports
        // it. `providers_tried` above drops an attempt with no provider name and so
        // cannot be index-aligned with anything; this is the shape that can be
        // aggregated — per provider, how often it was tried, how often it failed,
        // and how slow it was when it did.
        //
        // Deliberately an array of objects rather than parallel arrays. Core stores
        // attributes as `map[string]interface{}` marshalled to JSONB, so nesting
        // survives untouched and one `jsonb_array_elements` reaches every field.
        // Parallel arrays would need an index-zip in SQL and silently mis-pair the
        // moment one array is shorter than another.
        attrs['gen_ai.routing.attempts'] = p.attempts.map((a) => ({
            provider: a.provider ?? null,
            status: a.status ?? null,
            latency_ms: a.latencyMs ?? null,
            error: a.error ?? null,
        }));
    }
    if (p.requested?.only != null)
        attrs['openbox.routing.requested_only'] = p.requested.only;
    if (p.requested?.order != null)
        attrs['openbox.routing.requested_order'] = p.requested.order;
    if (p.requested?.allowFallbacks != null) {
        attrs['openbox.routing.allow_fallbacks'] = p.requested.allowFallbacks;
    }
    if (p.honored != null)
        attrs['openbox.routing.honored'] = p.honored;
    put('openbox.model.requested', p.requestedModel);
    if (p.modelHonored != null)
        attrs['openbox.model.honored'] = p.modelHonored;
    // The residency claim travels WITH the record it is judged against, not only
    // on the pre-flight span, so the comparison is legible from this one span
    // alone — a reader (or a policy) holding the provenance row should not have
    // to go and find the routing row to learn what the approved list was.
    if (p.residency != null)
        Object.assign(attrs, (0, residency_1.residencyAttributes)(p.residency));
    if (p.regionHonored != null)
        attrs['openbox.residency.region_honored'] = p.regionHonored;
    if (p.ownKeyHonored != null)
        attrs['openbox.residency.own_key_honored'] = p.ownKeyHonored;
    return attrs;
}
