/**
 * Regression guard for db span naming.
 *
 * buildDbSpanData derived its span name by running the statement through
 * classifySql, which only recognises SQL verbs. Redis statements are commands
 * ("GET key") and Mongo statements are JSON ('{"find":{...}}'), so both fell
 * through to UNKNOWN — a hosted trace came back with five of seven spans named
 * "UNKNOWN redis", which made the trace unreadable even though the command was
 * sitting right there in db_statement.
 *
 * Callers that already know their operation now pass it; classifySql stays as
 * the fallback for drivers whose statement genuinely is SQL.
 */
import { describe, expect, it } from 'vitest';
import { buildDbSpanData } from '../shared/langchain/node_instrumentation';

const base = { stage: 'started', startMs: 1000 } as const;

describe('db span naming', () => {
  it('names redis spans by their command, not UNKNOWN', () => {
    for (const [statement, expected] of [
      ['GET sess:1', 'GET'],
      ['SET sess:1 {}', 'SET'],
      ['HGETALL memory:1', 'HGETALL'],
    ] as const) {
      const span = buildDbSpanData('act-1', {
        dbSystem: 'redis',
        operation: statement.split(' ')[0],
        statement,
        ...base,
      }) as Record<string, unknown>;
      expect(span.name).toBe(`${expected} redis`);
      expect(span.db_operation).toBe(expected);
    }
  });

  it('names mongo spans by their method, not UNKNOWN', () => {
    const span = buildDbSpanData('act-1', {
      dbSystem: 'mongodb',
      operation: 'FIND',
      statement: '{"find":{"_id":1}}',
      ...base,
    }) as Record<string, unknown>;
    expect(span.name).toBe('FIND mongodb');
  });

  it('still classifies real SQL when the caller supplies no operation', () => {
    const span = buildDbSpanData('act-1', {
      dbSystem: 'postgresql',
      statement: 'select * from runs where id = $1',
      ...base,
    }) as Record<string, unknown>;
    expect(span.name).toBe('SELECT postgresql');
    expect(span.db_operation).toBe('SELECT');
  });

  it('keeps the started and completed halves on one span_id', () => {
    const common = { dbSystem: 'redis', operation: 'GET', statement: 'GET k', startMs: 1000 };
    const started = buildDbSpanData('act-1', { ...common, stage: 'started' }) as Record<string, unknown>;
    const completed = buildDbSpanData('act-1', {
      ...common, stage: 'completed', endMs: 1200,
    }) as Record<string, unknown>;
    expect(started.span_id).toBe(completed.span_id);
  });
});
