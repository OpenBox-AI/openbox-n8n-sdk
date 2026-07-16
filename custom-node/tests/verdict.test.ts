import { describe, expect, it } from 'vitest';

import {
  GovernanceBlockedError,
  GovernanceHaltError,
  GuardrailsValidationError,
  formatActivityRejectedMessage,
  unwrapGovernanceError,
} from '../shared/langchain/verdict';

describe('formatActivityRejectedMessage', () => {
  it('includes the reason when Core provides one', () => {
    expect(formatActivityRejectedMessage('too risky')).toBe('Activity rejected: too risky');
  });

  it('does not repeat "Activity rejected" when no reason is given', () => {
    expect(formatActivityRejectedMessage(undefined)).toBe('Activity rejected (no reason provided)');
    expect(formatActivityRejectedMessage(null)).toBe('Activity rejected (no reason provided)');
    expect(formatActivityRejectedMessage('')).toBe('Activity rejected (no reason provided)');
    expect(formatActivityRejectedMessage('   ')).toBe('Activity rejected (no reason provided)');
  });
});

describe('unwrapGovernanceError', () => {
  it('returns the error itself when it already is a governance error', () => {
    const err = new GovernanceHaltError('Activity rejected: no');
    expect(unwrapGovernanceError(err)).toBe(err);
  });

  it('recovers a GovernanceHaltError wrapped by a generic SDK transport error (the OpenAI-SDK case)', () => {
    const halt = new GovernanceHaltError('Activity rejected: no');
    // Mirrors openai's APIConnectionError: message = 'Connection error.', cause = original error.
    class FakeAPIConnectionError extends Error {
      constructor(cause: Error) {
        super('Connection error.');
        this.cause = cause;
      }
    }
    const wrapped = new FakeAPIConnectionError(halt);
    const recovered = unwrapGovernanceError(wrapped);
    expect(recovered).toBe(halt);
    expect(recovered?.message).toBe('Activity rejected: no');
  });

  it('recovers a GovernanceBlockedError nested two levels deep', () => {
    const blocked = new GovernanceBlockedError('block', 'blocked by policy');
    const middle = new Error('middle wrapper');
    (middle as { cause?: unknown }).cause = blocked;
    const outer = new Error('outer wrapper');
    (outer as { cause?: unknown }).cause = middle;
    expect(unwrapGovernanceError(outer)).toBe(blocked);
  });

  it('recovers a GuardrailsValidationError too', () => {
    const guard = new GuardrailsValidationError(['pii detected']);
    const wrapper = new Error('wrapped');
    (wrapper as { cause?: unknown }).cause = guard;
    expect(unwrapGovernanceError(wrapper)).toBe(guard);
  });

  it('returns null when there is no governance error anywhere in the chain', () => {
    expect(unwrapGovernanceError(new Error('just a network blip'))).toBeNull();
    expect(unwrapGovernanceError('not even an object')).toBeNull();
  });

  it('does not infinite-loop on a cyclic cause chain', () => {
    const a = new Error('a');
    const b = new Error('b');
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;
    expect(unwrapGovernanceError(a)).toBeNull();
  });
});
