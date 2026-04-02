import test from 'node:test';
import assert from 'node:assert/strict';

import { createMessageDeduper } from '../src/lib/message-dedup.js';

test('prevents duplicate delivery for the same message_id (issue #68 regression)', () => {
  let now = 1_000;
  const duplicates = [];
  const deduper = createMessageDeduper({
    ttlMs: 5_000,
    now: () => now,
    logDuplicate: (messageId) => duplicates.push(messageId),
  });

  assert.equal(deduper.checkAndMark('om_1'), false);
  now += 100;
  assert.equal(deduper.checkAndMark('om_1'), true);
  assert.deepEqual(duplicates, ['om_1']);
});

test('lets an expired message_id through even before the periodic sweep runs', () => {
  let now = 10_000;
  const deduper = createMessageDeduper({
    ttlMs: 5_000,
    now: () => now,
  });

  assert.equal(deduper.checkAndMark('om_2'), false);
  now += 5_001;
  assert.equal(deduper.checkAndMark('om_2'), false);
});

test('sweepExpired removes old entries and keeps recent ones', () => {
  let now = 20_000;
  const deduper = createMessageDeduper({
    ttlMs: 5_000,
    now: () => now,
  });

  deduper.checkAndMark('old');
  now += 2_000;
  deduper.checkAndMark('recent');
  now += 3_001;

  deduper.sweepExpired();

  assert.equal(deduper.size(), 1);
  assert.equal(deduper.checkAndMark('old'), false);
  assert.equal(deduper.checkAndMark('recent'), true);
});

test('ignores empty message ids', () => {
  const deduper = createMessageDeduper();

  assert.equal(deduper.checkAndMark(''), false);
  assert.equal(deduper.checkAndMark(null), false);
  assert.equal(deduper.size(), 0);
});
