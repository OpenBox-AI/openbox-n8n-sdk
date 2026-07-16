"use strict";
/**
 * Verdict enforcement — TypeScript port of openbox_langgraph/verdict_handler.py.
 *
 * enforce_verdict() maps governance verdict arms to exceptions. The Python SDK
 * also has GovernanceBlockedError for OTel hook-level blocks; we include it
 * here for structural completeness even though n8n skips the OTel layer.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GuardrailsValidationError = exports.GovernanceBlockedError = exports.GovernanceHaltError = void 0;
exports.unwrapGovernanceError = unwrapGovernanceError;
exports.formatActivityRejectedMessage = formatActivityRejectedMessage;
exports.enforceVerdict = enforceVerdict;
exports.verdictFromString = verdictFromString;
class GovernanceHaltError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GovernanceHaltError';
    }
}
exports.GovernanceHaltError = GovernanceHaltError;
class GovernanceBlockedError extends Error {
    verdict;
    constructor(verdict, message) {
        super(message);
        this.name = 'GovernanceBlockedError';
        this.verdict = verdict;
    }
}
exports.GovernanceBlockedError = GovernanceBlockedError;
class GuardrailsValidationError extends Error {
    reasons;
    constructor(reasons) {
        super(reasons.length > 0 ? reasons.join('; ') : 'Guardrails validation failed');
        this.name = 'GuardrailsValidationError';
        this.reasons = reasons;
    }
}
exports.GuardrailsValidationError = GuardrailsValidationError;
/**
 * Recover one of our own governance errors from anywhere in an error's cause
 * chain. Needed because a GovernanceHaltError/GovernanceBlockedError thrown
 * *inside* a patched fetch (e.g. when a mid-call HTTP hook evaluation gets
 * rejected) surfaces to the caller through whatever HTTP client library made
 * that call — and most Node HTTP clients (the OpenAI SDK included) catch
 * ANY error their fetch implementation throws and wrap it in a generic
 * transport error (e.g. `APIConnectionError` with the fixed message
 * "Connection error."), stashing the real cause in `.cause`. Without
 * unwrapping, both the error surfaced to the user AND the closure telemetry
 * sent to Core would show "Connection error." instead of the real reason
 * (e.g. "Activity rejected: ..."). Mirrors extractGovernanceBlocked's cause-
 * chain walk but recognizes all three governance error types, not just
 * GovernanceBlockedError.
 */
function unwrapGovernanceError(err) {
    const seen = new Set();
    let current = err;
    while (current != null && !seen.has(current)) {
        seen.add(current);
        if (current instanceof GovernanceHaltError ||
            current instanceof GovernanceBlockedError ||
            current instanceof GuardrailsValidationError) {
            return current;
        }
        if (typeof current === 'object') {
            const record = current;
            current = record.cause ?? record.context;
        }
        else {
            current = null;
        }
    }
    return null;
}
/**
 * Format the "a human rejected this activity" message. Previously each poll
 * loop built this inline as `Activity rejected: ${response.reason ?? 'Activity
 * rejected'}`, which — whenever Core didn't send a reason — produced the
 * redundant "Activity rejected: Activity rejected".
 */
function formatActivityRejectedMessage(reason) {
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    return trimmed ? `Activity rejected: ${trimmed}` : 'Activity rejected (no reason provided)';
}
/**
 * enforce_verdict(response, phase) — direct port.
 *
 * Throws GovernanceHaltError/GovernanceBlockedError on halt/block.
 * Returns VerdictResult({ requiresHitl: true }) on require_approval.
 * Returns VerdictResult({ requiresHitl: false }) on allow/monitor/constrain.
 */
function enforceVerdict(response, phase) {
    const arm = verdictFromString(response.arm ?? response.verdict);
    if (arm === 'halt') {
        throw new GovernanceHaltError(`OpenBox governance halt at ${phase}: ${response.reason ?? 'halted by policy'}`);
    }
    if (arm === 'block') {
        throw new GovernanceBlockedError('block', `OpenBox governance block at ${phase}: ${response.reason ?? 'blocked by policy'}`);
    }
    const guardrails = response.guardrails_result ?? response.guardrailsResult;
    if (guardrails && guardrails.validation_passed === false) {
        const reasons = Array.isArray(guardrails.reasons)
            ? guardrails.reasons
                .map((r) => r.reason)
                .filter((r) => typeof r === 'string' && r.length > 0)
            : [];
        throw new GuardrailsValidationError(reasons);
    }
    if (arm === 'require_approval') {
        const approvalId = response.approval_id ?? response.approvalId ?? response.id;
        return { requiresHitl: true, approvalId };
    }
    return { requiresHitl: false };
}
function verdictFromString(value) {
    if (typeof value !== 'string')
        return 'allow';
    const normalized = value.toLowerCase().replace(/-/g, '_');
    if (normalized === 'continue')
        return 'allow';
    if (normalized === 'stop')
        return 'halt';
    if (normalized === 'request_approval')
        return 'require_approval';
    if (normalized === 'allow' ||
        normalized === 'monitor' ||
        normalized === 'constrain' ||
        normalized === 'block' ||
        normalized === 'halt' ||
        normalized === 'require_approval') {
        return normalized;
    }
    return 'allow';
}
