import test from 'node:test';
import assert from 'node:assert/strict';

import { hasMarkdownContent } from '../src/lib/markdown.js';
import { mergeConfigWithDefaults } from '../src/lib/config.js';

test('detects markdown patterns called out in issue 57', () => {
  const cases = [
    '# Title',
    'Use **bold** text',
    'Use *italic* text',
    '*italic*',
    '_italic_',
    'Use `inline code` here',
    '```\nconst x = 1;\n```',
    '- item one\n- item two',
    '1. first\n2. second',
    '> quoted text',
    '[OpenAI](https://openai.com)',
    '| a | b |\n| --- | --- |\n| 1 | 2 |',
    '~~deprecated~~'
  ];

  for (const sample of cases) {
    assert.equal(hasMarkdownContent(sample), true, sample);
  }
});

test('does not upgrade ordinary plain text to markdown cards', () => {
  const cases = [
    'Hello world',
    'Version 1.2.3 is live',
    'Use a-b testing for rollout',
    '2 * 3 = 6',
    'A | B is a logical expression',
    'Visit https://example.com for details',
    '>not actually a quote',
    'list - item in one line'
  ];

  for (const sample of cases) {
    assert.equal(hasMarkdownContent(sample), false, sample);
  }
});

test('runtime config merge preserves markdown-card default for partial message config', () => {
  const merged = mergeConfigWithDefaults({
    message: {
      context_messages: 20
    }
  });

  assert.equal(merged.message.context_messages, 20);
  assert.equal(merged.message.useMarkdownCard, true);
});
