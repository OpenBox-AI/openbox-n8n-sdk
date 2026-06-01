import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';

import {
  humanize,
  matchesFilters,
  parseEvent,
  verifyHmac,
} from '../src/nodes/OpenBoxTrigger/OpenBoxTrigger.node';

describe('humanize', () => {
  it('title-cases dot-separated event slugs', () => {
    expect(humanize('approval.resolved')).toBe('Approval Resolved');
  });

  it('handles snake_case slugs', () => {
    expect(humanize('trust_tier_changed')).toBe('Trust Tier Changed');
  });
});

describe('verifyHmac', () => {
  const secret = 'shhh-very-secret';
  const payload = '{"event":"approval.resolved","data":{"approval_id":"a1"}}';

  function sign(body: string, key = secret): string {
    return createHmac('sha256', key).update(body).digest('hex');
  }

  it('accepts a valid bare hex digest', () => {
    expect(verifyHmac(secret, payload, sign(payload))).toBe(true);
  });

  it('accepts the prefixed sha256= form', () => {
    expect(verifyHmac(secret, payload, `sha256=${sign(payload)}`)).toBe(true);
  });

  it('rejects a digest signed with a different secret', () => {
    expect(verifyHmac(secret, payload, sign(payload, 'wrong-secret'))).toBe(false);
  });

  it('rejects a digest of a tampered payload', () => {
    expect(verifyHmac(secret, payload, sign(`${payload}!`))).toBe(false);
  });

  it('rejects malformed hex strings without throwing', () => {
    expect(verifyHmac(secret, payload, 'not-hex-at-all')).toBe(false);
    expect(verifyHmac(secret, payload, '')).toBe(false);
  });

  it('rejects digests of the wrong length', () => {
    // Length mismatch must short-circuit before timingSafeEqual to
    // avoid Buffer.from throwing on odd-length hex.
    expect(verifyHmac(secret, payload, 'deadbeef')).toBe(false);
  });
});

describe('parseEvent', () => {
  it('reads {event, data} envelope', () => {
    const out = parseEvent({ event: 'approval.resolved', data: { approval_id: 'x' } });
    expect(out).toEqual({
      type: 'approval.resolved',
      data: { approval_id: 'x' },
    });
  });

  it('reads {type, ...rest} envelope and treats the body as data', () => {
    const out = parseEvent({ type: 'policy.changed', policy_id: 'p1' });
    expect(out?.type).toBe('policy.changed');
    expect(out?.data).toMatchObject({ policy_id: 'p1' });
  });

  it('reads {event_type, ...} envelope', () => {
    const out = parseEvent({ event_type: 'alert.created', alert_id: 'a1' });
    expect(out?.type).toBe('alert.created');
  });

  it('returns undefined for empty / non-object bodies', () => {
    expect(parseEvent(undefined)).toBeUndefined();
    expect(parseEvent(null)).toBeUndefined();
    expect(parseEvent('string-body')).toBeUndefined();
    expect(parseEvent({})).toBeUndefined();
  });
});

describe('matchesFilters', () => {
  it('matches when no filters are configured', () => {
    expect(matchesFilters({ approval_id: 'a' }, {})).toBe(true);
  });

  it('matches snake_case event fields against camelCase filter keys', () => {
    expect(matchesFilters({ approval_id: 'a1' }, { approvalId: 'a1' })).toBe(true);
  });

  it('also matches camelCase event fields', () => {
    expect(matchesFilters({ approvalId: 'a1' }, { approvalId: 'a1' })).toBe(true);
  });

  it('rejects mismatching approval ids', () => {
    expect(matchesFilters({ approval_id: 'a1' }, { approvalId: 'a2' })).toBe(false);
  });

  it('rejects events below the configured min risk score', () => {
    expect(matchesFilters({ risk_score: 0.2 }, { minRiskScore: 0.5 })).toBe(false);
  });

  it('accepts events at or above the configured min risk score', () => {
    expect(matchesFilters({ risk_score: 0.7 }, { minRiskScore: 0.5 })).toBe(true);
  });

  it('rejects events with no risk score when a min is set', () => {
    expect(matchesFilters({}, { minRiskScore: 0.1 })).toBe(false);
  });

  it('allows events with no risk score when min is zero / unset', () => {
    expect(matchesFilters({}, {})).toBe(true);
    expect(matchesFilters({}, { minRiskScore: 0 })).toBe(true);
  });
});
