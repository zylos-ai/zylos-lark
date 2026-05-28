import test from 'node:test';
import assert from 'node:assert/strict';

import { hasLarkAtTag, resolveOutgoingMentions } from '../src/lib/mention.js';

test('detects existing Lark at tags', () => {
  assert.equal(hasLarkAtTag('<at user_id="ou_123">zylos101</at> review done'), true);
  assert.equal(hasLarkAtTag('<at user_id="all"></at> deploy notice'), true);
  assert.equal(hasLarkAtTag('&lt;at user_id="ou_123"&gt;zylos101&lt;/at&gt;'), false);
  assert.equal(hasLarkAtTag('@zylos101 review done'), false);
});

test('resolves registry mentions to Lark at tags', () => {
  const result = resolveOutgoingMentions('cc @zylos101 review done', {
    zylos101: { open_id: 'ou_75577b719ba124bf7dec9f93f9e86763' },
  });

  assert.equal(result.hasMentions, true);
  assert.equal(
    result.resolved,
    'cc <at user_id="ou_75577b719ba124bf7dec9f93f9e86763">zylos101</at> review done'
  );
});

test('treats existing at tags as mentions even without registry entries', () => {
  const source = [
    '<at user_id="ou_75577b719ba124bf7dec9f93f9e86763">zylos101</at> re-review 完成。',
    '',
    '- `git diff --check` passed',
  ].join('\n');

  const result = resolveOutgoingMentions(source, {});

  assert.equal(result.hasMentions, true);
  assert.equal(result.resolved, source);
});
