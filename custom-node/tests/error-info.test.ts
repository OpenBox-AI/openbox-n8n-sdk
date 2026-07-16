import { describe, expect, it } from 'vitest';

import { safeString, toErrorInfo } from '../shared/langchain/error-info';

describe('toErrorInfo', () => {
  it('preserves name as type, message, and stack as stack_trace', () => {
    const err = new TypeError('bad input');
    const info = toErrorInfo(err);
    expect(info.type).toBe('TypeError');
    expect(info.message).toBe('bad input');
    expect(info.stack_trace).toContain('TypeError');
  });

  it('preserves a custom Error subclass name (not constructor.name)', () => {
    class GovernanceHaltError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'GovernanceHaltError';
      }
    }
    const info = toErrorInfo(new GovernanceHaltError('blocked'));
    expect(info.type).toBe('GovernanceHaltError');
    expect(info.message).toBe('blocked');
  });

  it('omits stack_trace when absent', () => {
    const err = new Error('x');
    delete (err as { stack?: string }).stack;
    const info = toErrorInfo(err);
    expect(info.stack_trace).toBeUndefined();
  });

  it('never produces a bare string for non-Error thrown values', () => {
    expect(toErrorInfo('just a string')).toEqual({ type: 'Error', message: 'just a string' });
    expect(toErrorInfo(42)).toEqual({ type: 'Error', message: '42' });
    expect(toErrorInfo(null)).toEqual({ type: 'Error', message: 'null' });
  });

  it('survives a hostile toString()/null-prototype thrown value', () => {
    const hostile = Object.create(null);
    hostile.toString = () => {
      throw new Error('nope');
    };
    expect(() => toErrorInfo(hostile)).not.toThrow();
    const info = toErrorInfo(hostile);
    expect(info.type).toBe('Error');
    expect(typeof info.message).toBe('string');
  });
});

describe('safeString', () => {
  it('never throws for a hostile toString()', () => {
    const hostile = { toString: () => { throw new Error('nope'); } };
    expect(() => safeString(hostile)).not.toThrow();
  });
});
