import { describe, expect, it } from 'vitest';

import { safeSerialize } from '../shared/langchain/types';

describe('safeSerialize', () => {
  it('passes primitives through unchanged', () => {
    expect(safeSerialize('hi')).toBe('hi');
    expect(safeSerialize(42)).toBe(42);
    expect(safeSerialize(true)).toBe(true);
    expect(safeSerialize(null)).toBeNull();
    expect(safeSerialize(undefined)).toBeNull();
  });

  it('coerces non-finite numbers to null', () => {
    expect(safeSerialize(Number.NaN)).toBeNull();
    expect(safeSerialize(Number.POSITIVE_INFINITY)).toBeNull();
    expect(safeSerialize({ n: Number.NaN })).toEqual({ n: null });
  });

  it('coerces BigInt to a string, including nested', () => {
    expect(safeSerialize(10n)).toBe('10');
    expect(safeSerialize({ count: 10n })).toEqual({ count: '10' });
  });

  it('converts Map to a plain object without losing entries', () => {
    expect(safeSerialize(new Map([['k', 1], ['j', 2]]))).toEqual({ k: 1, j: 2 });
  });

  it('converts Set to an array without losing members', () => {
    expect(safeSerialize(new Set([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  it('converts Date to an ISO string', () => {
    const d = new Date('2024-01-01T00:00:00.000Z');
    expect(safeSerialize(d)).toBe('2024-01-01T00:00:00.000Z');
  });

  it('replaces only the cyclic edge, preserving sibling fields', () => {
    const a: Record<string, unknown> = { name: 'a', sibling: { ok: true } };
    a.self = a;
    expect(safeSerialize(a)).toEqual({ name: 'a', sibling: { ok: true }, self: '[Circular]' });
  });

  it('never throws for a hostile toString()/null-prototype value', () => {
    const hostile = Object.create(null);
    hostile.toString = () => {
      throw new Error('nope');
    };
    expect(() => safeSerialize(hostile)).not.toThrow();
  });

  it('breaks a self-referential Map instead of stack-overflowing', () => {
    const m = new Map<string, unknown>();
    m.set('self', m);
    expect(() => safeSerialize(m)).not.toThrow();
    expect(safeSerialize(m)).toEqual({ self: '[Circular]' });
  });

  it('breaks a self-referential Set instead of stack-overflowing', () => {
    const s = new Set<unknown>();
    s.add(s);
    expect(() => safeSerialize(s)).not.toThrow();
    expect(safeSerialize(s)).toEqual(['[Circular]']);
  });

  it('never throws for a throwing property getter', () => {
    const hostile: Record<string, unknown> = { fine: 1 };
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter boom');
      },
    });
    expect(() => safeSerialize(hostile)).not.toThrow();
    expect(safeSerialize(hostile)).toEqual({ fine: 1, boom: '[Unserializable]' });
  });

  it('functions and symbols become null, including nested', () => {
    expect(safeSerialize(() => {})).toBeNull();
    expect(safeSerialize({ fn: () => {} })).toEqual({ fn: null });
  });
});
