"use strict";
/**
 * Core types for the OpenBox LangChain governance SDK (TypeScript port).
 *
 * Mirrors openbox_langgraph/types.py — identical field names so events are
 * interchangeable with the Python SDK and Core classifies them the same way.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.rfc3339Now = rfc3339Now;
exports.safeSerialize = safeSerialize;
exports.stableSpanId = stableSpanId;
exports.hexId = hexId;
/** rfc3339_now() — mirrors openbox_langgraph.types.rfc3339_now */
function rfc3339Now() {
    return new Date().toISOString();
}
/**
 * safe_serialize() — recursive, cycle-safe JSON coercion.
 *
 * Unlike a bare JSON.parse(JSON.stringify(...)) round-trip, this:
 *  - replaces only the cyclic edge with "[Circular]" (siblings survive)
 *  - converts Map → plain object, Set → array (JSON.stringify turns both into "{}")
 *  - converts BigInt → string, non-finite numbers → null
 *  - never throws, even for a hostile toString()/null-prototype value
 */
function safeSerialize(value) {
    return toJsonSafeInner(value, new WeakSet());
}
function toJsonSafeInner(value, seen) {
    if (value === null || value === undefined)
        return null;
    const t = typeof value;
    if (t === 'string' || t === 'boolean')
        return value;
    if (t === 'number')
        return Number.isFinite(value) ? value : null;
    if (t === 'bigint')
        return value.toString();
    if (t === 'function' || t === 'symbol')
        return null;
    if (value instanceof Date)
        return value.toISOString();
    if (Array.isArray(value)) {
        if (seen.has(value))
            return '[Circular]';
        seen.add(value);
        return value.map((v) => toJsonSafeInner(v, seen));
    }
    if (value instanceof Map) {
        if (seen.has(value))
            return '[Circular]';
        seen.add(value);
        const obj = {};
        for (const [k, v] of value)
            obj[String(k)] = toJsonSafeInner(v, seen);
        return obj;
    }
    if (value instanceof Set) {
        if (seen.has(value))
            return '[Circular]';
        seen.add(value);
        return Array.from(value.values()).map((v) => toJsonSafeInner(v, seen));
    }
    if (t === 'object') {
        if (seen.has(value))
            return '[Circular]';
        seen.add(value);
        const rec = value;
        const toJson = rec.toJSON;
        if (typeof toJson === 'function') {
            try {
                return toJsonSafeInner(toJson.call(rec), seen);
            }
            catch {
                // fall through to plain-object field enumeration
            }
        }
        const out = {};
        for (const key of Object.keys(rec)) {
            // A getter/accessor property can throw on read (hostile input, or a
            // proxy) — guard each field individually so one bad property doesn't
            // take down serialization of the whole object.
            try {
                out[key] = toJsonSafeInner(rec[key], seen);
            }
            catch {
                out[key] = '[Unserializable]';
            }
        }
        return out;
    }
    try {
        return String(value);
    }
    catch {
        return '[Unserializable]';
    }
}
/**
 * Deterministic 16-char hex span id derived from a seed.
 *
 * The started and completed halves of one operation MUST carry the same
 * span_id: OpenBox Core creates the span row from the started hook and expects
 * the completed hook to fill in duration/end_time, correlating them by span_id.
 * A random id per stage leaves every span showing "started" with no duration.
 */
function stableSpanId(seed) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require('crypto');
    return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}
/** Crypto-random hex ID. Mirrors uuid.uuid4().hex in Python. */
function hexId(len = 32) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { randomBytes } = require('crypto');
    return randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}
