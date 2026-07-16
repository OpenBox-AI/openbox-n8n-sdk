import { describe, expect, it } from 'vitest';

import { extractLastUserMessage, extractPromptFromMessages, hasHumanTurn } from '../shared/langchain/hooks';

describe('message role recognition — consistency across extraction functions', () => {
  it('extractLastUserMessage recognizes human, user, and generic roles alike', () => {
    expect(extractLastUserMessage([['human', 'a']])).toBe('a');
    expect(extractLastUserMessage([['user', 'b']])).toBe('b');
    expect(extractLastUserMessage([{ type: 'generic', content: 'c' }])).toBe('c');
  });

  it('extractPromptFromMessages also recognizes all three roles (already did)', () => {
    expect(extractPromptFromMessages([{ type: 'generic', content: 'c' }])).toBe('c');
  });

  it('hasHumanTurn is true for human/user/generic roles, false otherwise', () => {
    expect(hasHumanTurn([['human', '']])).toBe(true);
    expect(hasHumanTurn([['user', '']])).toBe(true);
    expect(hasHumanTurn([{ type: 'generic', content: '' }])).toBe(true);
    expect(hasHumanTurn([{ type: 'ai', content: 'response' }])).toBe(false);
  });

  it('a message via a real .getType() method resolves the same as a plain .type property', () => {
    class FakeBaseMessage {
      constructor(private content_: string) {}
      getType() {
        return 'human';
      }
      get content() {
        return this.content_;
      }
    }
    expect(extractLastUserMessage([new FakeBaseMessage('hello') as unknown as Record<string, unknown>])).toBe('hello');
  });
});
