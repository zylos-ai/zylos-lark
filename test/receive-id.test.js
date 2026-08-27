import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDmReceiveIdType } from '../src/lib/receive-id.js';

test('open ids are sent as open_id', () => {
  assert.equal(resolveDmReceiveIdType('ou_de88fc16e5765e803a0ae2e64a136017'), 'open_id');
});

test('chat ids are sent as chat_id', () => {
  assert.equal(resolveDmReceiveIdType('oc_33cea02f01edfc5057ad834fe6425831'), 'chat_id');
});

test('unknown and malformed ids fall back to chat_id', () => {
  for (const id of ['', 'on_message_id', 'ou', undefined, null, 12345]) {
    assert.equal(resolveDmReceiveIdType(id), 'chat_id');
  }
});

test('the ou_ prefix is matched at the start only', () => {
  assert.equal(resolveDmReceiveIdType('oc_ou_not_an_open_id'), 'chat_id');
});
