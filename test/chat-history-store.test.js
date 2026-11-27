import test from 'node:test';
import assert from 'node:assert/strict';

import { createChatHistoryStore } from '../src/lib/chat-history-store.js';

const msg = (id, text = id) => ({ message_id: id, text, timestamp: '2026-01-01T00:00:00Z' });

test('evicts the least-recently-used key at the cap, keeping a touched key', () => {
  const evicted = [];
  const store = createChatHistoryStore({
    maxChats: 3,
    onEvict: (key, reason) => evicted.push([key, reason]),
  });
  store.record('a', msg('a1'), 5);
  store.record('b', msg('b1'), 5);
  store.record('c', msg('c1'), 5);
  // Touch 'a' via a write so 'b' becomes the oldest untouched key.
  store.record('a', msg('a2'), 5);
  store.record('d', msg('d1'), 5);

  assert.equal(store.size(), 3);
  assert.equal(store.has('b'), false);
  assert.deepEqual(store.keys(), ['c', 'a', 'd']);
  assert.deepEqual(evicted, [['b', 'lru']]);
  assert.deepEqual(store.get('a').map(m => m.message_id), ['a1', 'a2']);
});

test('reads refresh recency', () => {
  const store = createChatHistoryStore({ maxChats: 2 });
  store.record('a', msg('a1'), 5);
  store.record('b', msg('b1'), 5);
  assert.ok(store.get('a'));
  store.record('c', msg('c1'), 5);
  assert.equal(store.has('a'), true);
  assert.equal(store.has('b'), false);
});

test('expires keys idle longer than the TTL (measured from last write or read)', () => {
  let now = 0;
  const evicted = [];
  const store = createChatHistoryStore({
    idleTtlMs: 1_000,
    now: () => now,
    onEvict: (key, reason) => evicted.push([key, reason]),
  });
  store.record('a', msg('a1'), 5);
  store.record('b', msg('b1'), 5);

  now = 900;
  assert.ok(store.get('a')); // read refreshes 'a'

  now = 1_500; // 'b' idle 1500ms, 'a' idle 600ms
  assert.equal(store.sweep(), 1);
  assert.equal(store.has('b'), false);
  assert.equal(store.has('a'), true);
  assert.deepEqual(evicted, [['b', 'idle']]);

  now = 3_000;
  assert.equal(store.get('a'), undefined, 'expired key is dropped on read');
  assert.equal(store.size(), 0);
});

test('writes sweep idle keys lazily', () => {
  let now = 0;
  const store = createChatHistoryStore({ idleTtlMs: 1_000, now: () => now });
  store.record('old', msg('o1'), 5);
  now = 5_000;
  store.record('new', msg('n1'), 5);
  assert.deepEqual(store.keys(), ['new']);
});

test('limits accept getter functions and fall back to defaults when invalid', () => {
  let cap = 2;
  const store = createChatHistoryStore({ maxChats: () => cap });
  store.record('a', msg('a1'), 5);
  store.record('b', msg('b1'), 5);
  store.record('c', msg('c1'), 5);
  assert.equal(store.size(), 2);

  cap = undefined; // invalid -> default 500
  store.record('d', msg('d1'), 5);
  store.record('e', msg('e1'), 5);
  assert.equal(store.size(), 4);
});

test('dedupes by message_id and trims per key to limit once it exceeds 2 * limit', () => {
  const store = createChatHistoryStore();
  store.record('a', msg('m1'), 2);
  store.record('a', msg('m1', 'dup'), 2);
  assert.deepEqual(store.get('a').map(m => m.text), ['m1']);

  store.record('a', msg('m2'), 2);
  store.record('a', msg('m3'), 2);
  store.record('a', msg('m4'), 2);
  assert.equal(store.get('a').length, 4);
  store.record('a', msg('m5'), 2);
  assert.deepEqual(store.get('a').map(m => m.message_id), ['m4', 'm5']);

  // Entries without message_id are never deduped.
  store.record('b', { text: 'x' }, 5);
  store.record('b', { text: 'x' }, 5);
  assert.equal(store.get('b').length, 2);
});

test('normalizes keys like the previous Map usage', () => {
  const store = createChatHistoryStore();
  store.record(null, msg('n1'), 5);
  store.record(123, msg('n2'), 5);
  assert.equal(store.get(undefined).length, 1);
  assert.equal(store.get('123').length, 1);
  assert.equal(store.get('missing'), undefined);
});

test('a numeric-string limit (hand-edited config) still trims the history', () => {
  const store = createChatHistoryStore();
  for (let i = 0; i < 100; i++) store.record('chat', msg(`m${i}`), '5');
  const entries = store.get('chat');
  assert.ok(entries.length <= 10, `kept ${entries.length}, want at most 2 * 5`);
  assert.equal(entries.at(-1).message_id, 'm99');
});
