"use strict";
/**
 * URL prefixes the HTTP instrumentation never captures: OpenBox Core itself,
 * and the Keycloak token endpoint the v3 workload identity talks to. Capturing
 * either would post the SDK's own governance traffic back to Core as hook
 * spans, which loops.
 *
 * Kept apart from span_processor so the Core client can register an authority
 * without importing the instrumentation (which imports the client).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.addIgnoredPrefix = addIgnoredPrefix;
exports.shouldIgnore = shouldIgnore;
const _ignoredPrefixes = [
    'https://core.openbox.ai',
    'http://core.openbox.ai',
];
/** Register an extra URL prefix to ignore (e.g. a self-hosted Core or a Keycloak issuer). */
function addIgnoredPrefix(prefix) {
    const normalised = prefix.replace(/\/+$/, '');
    if (normalised && !_ignoredPrefixes.includes(normalised)) {
        _ignoredPrefixes.push(normalised);
    }
}
function shouldIgnore(url) {
    return _ignoredPrefixes.some((p) => url.startsWith(p));
}
