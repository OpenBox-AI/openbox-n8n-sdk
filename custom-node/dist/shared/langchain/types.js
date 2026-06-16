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
exports.hexId = hexId;
/** rfc3339_now() — mirrors openbox_langgraph.types.rfc3339_now */
function rfc3339Now() {
    return new Date().toISOString();
}
/** safe_serialize() — mirrors openbox_langgraph.types.safe_serialize */
function safeSerialize(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    try {
        return JSON.parse(JSON.stringify(value));
    }
    catch {
        return String(value);
    }
}
/** Crypto-random hex ID. Mirrors uuid.uuid4().hex in Python. */
function hexId(len = 32) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { randomBytes } = require('crypto');
    return randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}
