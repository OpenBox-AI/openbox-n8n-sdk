import { describe, expect, it } from 'vitest';

import { applyPiiRedaction } from '../shared/langchain/hooks';

describe('applyPiiRedaction', () => {
  it('replaces string content on a tuple-form human message', () => {
    const messages: unknown[] = [['system', 'sys'], ['human', 'my SSN is 123-45-6789']];
    applyPiiRedaction(messages, '[REDACTED]');
    expect(messages[1]).toEqual(['human', '[REDACTED]']);
  });

  it('coerces the legacy [{prompt}] shape', () => {
    const messages: unknown[] = [['human', 'raw']];
    applyPiiRedaction(messages, [{ prompt: 'redacted-via-prompt' }]);
    expect(messages[0]).toEqual(['human', 'redacted-via-prompt']);
  });

  it('coerces the [{text}] shape (previously unsupported — only .prompt was read)', () => {
    const messages: unknown[] = [['human', 'raw']];
    applyPiiRedaction(messages, [{ text: 'redacted-via-text' }]);
    expect(messages[0]).toEqual(['human', 'redacted-via-text']);
  });

  it('redacts only text blocks in multimodal content, preserving non-text blocks', () => {
    const imageBlock = { type: 'image_url', image_url: { url: 'https://example.com/x.png' } };
    const messages: unknown[] = [
      {
        type: 'human',
        content: [
          { type: 'text', text: 'my phone is 555-1234' },
          imageBlock,
        ],
      },
    ];
    applyPiiRedaction(messages, '[REDACTED-PHONE]');
    const content = (messages[0] as { content: unknown[] }).content;
    expect(content[0]).toEqual({ type: 'text', text: '[REDACTED-PHONE]' });
    // Non-text block (image) must survive untouched.
    expect(content[1]).toEqual(imageBlock);
  });

  it('is a no-op when the redacted value is empty/unrecognized', () => {
    const messages: unknown[] = [['human', 'raw']];
    applyPiiRedaction(messages, null);
    applyPiiRedaction(messages, '');
    applyPiiRedaction(messages, []);
    expect(messages[0]).toEqual(['human', 'raw']);
  });

  it('never touches a system or AI message', () => {
    const messages: unknown[] = [['system', 'sys'], { type: 'ai', content: 'response' }];
    applyPiiRedaction(messages, 'should not apply');
    expect(messages[0]).toEqual(['system', 'sys']);
    expect(messages[1]).toEqual({ type: 'ai', content: 'response' });
  });
});
