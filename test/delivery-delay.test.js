import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DELAYED_DELIVERY_MINUTES,
  delayedDeliveryNotice,
  delayThresholdMs,
  formatDelay,
  messageSentAt,
} from '../src/lib/delivery-delay.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN = 60_000;
const SENT = Date.UTC(2026, 8, 24, 3, 20, 12); // 2026-09-24 03:20:12 UTC

test('delayThresholdMs: default 10 min, 0 disables, invalid values fall back to the default', () => {
  assert.equal(DEFAULT_DELAYED_DELIVERY_MINUTES, 10);
  for (const unset of [undefined, null, '']) assert.equal(delayThresholdMs(unset), 10 * MIN);
  assert.equal(delayThresholdMs(0), null);
  assert.equal(delayThresholdMs('0'), null);
  assert.equal(delayThresholdMs(30), 30 * MIN);
  assert.equal(delayThresholdMs('15'), 15 * MIN);
  assert.equal(delayThresholdMs(0.5), 30_000);
  for (const invalid of [-5, 'abc', NaN, Infinity, {}]) assert.equal(delayThresholdMs(invalid), 10 * MIN, String(invalid));
});

test('messageSentAt prefers message.create_time and falls back to the event header', () => {
  assert.equal(messageSentAt({ create_time: String(SENT) }, { create_time: '1' }), SENT);
  assert.equal(messageSentAt({}, { create_time: String(SENT) }), SENT);
  assert.equal(messageSentAt({ create_time: SENT }, null), SENT);
  assert.equal(messageSentAt({ create_time: 'soon' }, { create_time: String(SENT) }), SENT);
  for (const [message, header] of [[{}, {}], [undefined, undefined], [{ create_time: '0' }, { create_time: '' }], [{ create_time: '-5' }, { create_time: '1.5' }]]) {
    assert.equal(messageSentAt(message, header), null, JSON.stringify([message, header]));
  }
});

test('formatDelay: seconds, minutes, hours and days', () => {
  assert.equal(formatDelay(45_000), '45s');
  assert.equal(formatDelay(12 * MIN + 59_000), '12m');
  assert.equal(formatDelay(60 * MIN), '1h00m');
  assert.equal(formatDelay((7 * 60 + 5) * MIN), '7h05m');
  assert.equal(formatDelay((24 * 60 - 1) * MIN), '23h59m');
  assert.equal(formatDelay((51 * 60 + 30) * MIN), '2d03h');
});

test('a message delivered hours late gets a notice with the UTC send time and the delay (#106)', () => {
  const now = SENT + (7 * 60 + 5) * MIN;
  assert.equal(delayedDeliveryNotice(SENT, { now, thresholdMs: 10 * MIN }),
    '[delayed delivery: sent 2026-09-24 03:20 UTC, 7h05m ago]');
  assert.equal(delayedDeliveryNotice(SENT, { now }), '[delayed delivery: sent 2026-09-24 03:20 UTC, 7h05m ago]',
    'default threshold');
});

test('no notice up to the threshold, for a future send time, when disabled or without a send time', () => {
  assert.equal(delayedDeliveryNotice(SENT, { now: SENT + 10 * MIN, thresholdMs: 10 * MIN }), null);
  assert.equal(delayedDeliveryNotice(SENT, { now: SENT + 10 * MIN + 1, thresholdMs: 10 * MIN }),
    '[delayed delivery: sent 2026-09-24 03:20 UTC, 10m ago]');
  assert.equal(delayedDeliveryNotice(SENT, { now: SENT - 5 * MIN, thresholdMs: 0 }), null, 'clock skew');
  assert.equal(delayedDeliveryNotice(SENT, { now: SENT + 24 * 60 * MIN, thresholdMs: null }), null, 'disabled');
  assert.equal(delayedDeliveryNotice(null, { now: SENT, thresholdMs: 10 * MIN }), null);
});

test('index.js marks every message it formats for C4 with the delay notice', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
  assert.match(src, /import \{ delayedDeliveryNotice, delayThresholdMs, messageSentAt \} from '\.\/lib\/delivery-delay\.js';/);

  // formatMessage puts the notice in front of the current-message text
  const format = src.slice(src.indexOf('function formatMessage('), src.indexOf('function extractPostText('));
  assert.match(format, /\{ quotedContent, threadContext, threadRootId, groupName, smartHint, delayNotice \} = \{\}/);
  assert.match(format, /const safeText = escapeXml\(delayNotice \? \[delayNotice, text\]\.filter\(Boolean\)\.join\(' '\) : text\);/);

  // computed once per message, from the configured threshold, before any DM/group branch
  const handler = src.slice(src.indexOf('async function handleMessageEvent('), src.indexOf('// Express app'));
  const compute = handler.indexOf('const delayNotice = delayedDeliveryNotice(messageSentAt(message, event.header), {');
  assert.ok(compute > 0, 'delayNotice computed in handleMessageEvent');
  assert.ok(handler.indexOf('delayThresholdMs(config.message?.delayed_delivery_minutes)') > compute);
  assert.ok(compute < handler.indexOf('await botIdentity.ensureForMessage()'), 'measured before any wait');
  assert.ok(compute < handler.indexOf("if (chatType === 'p2p')"));

  // every formatMessage call passes it
  const calls = handler.split('formatMessage(').slice(1).map((rest) => rest.slice(0, rest.indexOf(');')));
  assert.equal(calls.length, 16);
  for (const call of calls) assert.match(call, /\bdelayNotice\b/, call);
});
