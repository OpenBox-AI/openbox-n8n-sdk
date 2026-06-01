import { describe, expect, it } from 'vitest';

import {
  approvalStatusToOutputIndex,
  armToOutputIndex,
  normalizeVerdict,
  OUTPUT_INDEX,
  parseJsonParameter,
} from '../src/nodes/OpenBox/OpenBox.node';

describe('armToOutputIndex', () => {
  it('routes allow to the Allowed output', () => {
    expect(armToOutputIndex('allow')).toBe(OUTPUT_INDEX.ALLOWED);
  });

  it('routes constrain to the Constrained output', () => {
    expect(armToOutputIndex('constrain')).toBe(OUTPUT_INDEX.CONSTRAINED);
  });

  it('routes require_approval to the Approval Required output', () => {
    expect(armToOutputIndex('require_approval')).toBe(OUTPUT_INDEX.APPROVAL_REQUIRED);
  });

  it('routes block to the Blocked output', () => {
    expect(armToOutputIndex('block')).toBe(OUTPUT_INDEX.BLOCKED);
  });

  it('routes halt to the Halted output', () => {
    expect(armToOutputIndex('halt')).toBe(OUTPUT_INDEX.HALTED);
  });

  it('routes an unknown arm to the Error output', () => {
    expect(armToOutputIndex('something_new' as never)).toBe(OUTPUT_INDEX.ERROR);
  });
});

describe('approvalStatusToOutputIndex', () => {
  it('maps approved to Allowed', () => {
    expect(approvalStatusToOutputIndex('approved')).toBe(OUTPUT_INDEX.ALLOWED);
  });

  it.each(['denied', 'rejected', 'expired', 'timeout', 'cancelled', 'canceled'])(
    'maps %s to Blocked',
    (status) => {
      expect(approvalStatusToOutputIndex(status)).toBe(OUTPUT_INDEX.BLOCKED);
    },
  );

  it('maps pending statuses to Approval Required', () => {
    expect(approvalStatusToOutputIndex('pending')).toBe(OUTPUT_INDEX.APPROVAL_REQUIRED);
    expect(approvalStatusToOutputIndex('')).toBe(OUTPUT_INDEX.APPROVAL_REQUIRED);
  });
});

describe('normalizeVerdict', () => {
  it('prefers camelCase fields when both are present', () => {
    const out = normalizeVerdict({
      arm: 'allow',
      riskScore: 0.42,
      risk_score: 0.99,
      approvalId: 'a-1',
      approval_id: 'a-2',
    } as never);
    expect(out.riskScore).toBe(0.42);
    expect(out.approvalId).toBe('a-1');
  });

  it('falls back to snake_case when only that is present', () => {
    const out = normalizeVerdict({
      arm: 'block',
      risk_score: 0.99,
      approval_id: 'a-snake',
      governance_event_id: 'g-snake',
      trust_tier: 2,
      reason: 'policy hit',
    } as never);
    expect(out.riskScore).toBe(0.99);
    expect(out.approvalId).toBe('a-snake');
    expect(out.governanceEventId).toBe('g-snake');
    expect(out.trustTier).toBe(2);
    expect(out.reason).toBe('policy hit');
  });
});

describe('parseJsonParameter', () => {
  it('returns non-string values unchanged', () => {
    expect(parseJsonParameter({ a: 1 })).toEqual({ a: 1 });
    expect(parseJsonParameter([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('parses well-formed JSON strings', () => {
    expect(parseJsonParameter('{"x":1}')).toEqual({ x: 1 });
  });

  it('returns the original string when JSON.parse fails', () => {
    // Free-form values must survive so users can pass bare strings
    // without forcing them to add quotes.
    expect(parseJsonParameter('hello')).toBe('hello');
  });

  it('returns undefined for empty/whitespace strings', () => {
    expect(parseJsonParameter('')).toBeUndefined();
    expect(parseJsonParameter('   ')).toBeUndefined();
  });
});

describe('OUTPUT_INDEX layout invariants', () => {
  it('has exactly 6 outputs covering verdict arms + error', () => {
    // Adding/removing an output without updating the descriptor will
    // silently misroute verdicts; this test fails fast in that case.
    expect(Object.keys(OUTPUT_INDEX)).toHaveLength(6);
    expect(Object.values(OUTPUT_INDEX).sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
