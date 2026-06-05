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
