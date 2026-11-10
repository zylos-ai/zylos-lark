import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEndpoint } from '../src/lib/endpoint.js';
import {
  isValidSessionGroup,
  SESSION_GROUP_MAX_LENGTH,
  sessionGroupFromEndpoint
} from '../src/lib/session-group.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'session-group.js');

// Realistic shapes: chat_id is oc_ + 32 chars, thread_id is omt_ + 16 chars.
const CHAT = 'oc_0123456789abcdef0123456789abcdef';
const GROUP_CHAT = 'oc_fedcba9876543210fedcba9876543210';
const THREAD = 'omt_0a1b2c3d4e5f6a7b';

// T1: mapping table
const MAPPING = [
  ['DM', buildEndpoint(CHAT, { chatType: 'p2p', messageId: 'om_1' }), `dm-${CHAT}`],
  ['DM thread is not split', buildEndpoint(CHAT, { chatType: 'p2p', rootId: 'om_r', messageId: 'om_1', threadId: THREAD }), `dm-${CHAT}`],
  ['group', buildEndpoint(GROUP_CHAT, { chatType: 'group', messageId: 'om_1' }), `group-${GROUP_CHAT}`],
  ['group reply chain without thread stays in the group',
    buildEndpoint(GROUP_CHAT, { chatType: 'group', rootId: 'om_r', parentId: 'om_p', messageId: 'om_1' }), `group-${GROUP_CHAT}`],
  ['group topic', buildEndpoint(GROUP_CHAT, { chatType: 'group', rootId: 'om_r', messageId: 'om_1', threadId: THREAD }),
    `group-${GROUP_CHAT}:topic-${THREAD}`],
];

for (const [label, endpoint, expected] of MAPPING) {
  test(`maps ${label}`, () => {
    const name = sessionGroupFromEndpoint(endpoint);
    assert.equal(name, expected);
    assert.ok(isValidSessionGroup(name), `${name} must be valid for Core`);
    assert.ok(!name.startsWith('lark:'), 'Core adds the namespace, not the component');
  });
}

test('topic group name fits Core limits with room to spare', () => {
  const name = sessionGroupFromEndpoint(`${GROUP_CHAT}|type:group|thread:${THREAD}`);
  assert.equal(name.length, 68);
});

test('per-message parts (msg, root, parent) never change the group', () => {
  const a = buildEndpoint(GROUP_CHAT, { chatType: 'group', rootId: 'om_r1', parentId: 'om_p1', messageId: 'om_1', threadId: THREAD });
  const b = buildEndpoint(GROUP_CHAT, { chatType: 'group', rootId: 'om_r2', parentId: 'om_p2', messageId: 'om_2', threadId: THREAD });
  assert.equal(sessionGroupFromEndpoint(a), sessionGroupFromEndpoint(b));
  assert.equal(
    sessionGroupFromEndpoint(`${CHAT}|type:p2p|msg:om_1`),
    sessionGroupFromEndpoint(`${CHAT}|type:p2p|msg:om_2|parent:om_9`)
  );
  assert.equal(
    sessionGroupFromEndpoint(`${GROUP_CHAT}|type:group|msg:om_1`),
    sessionGroupFromEndpoint(`${GROUP_CHAT}|type:group|msg:om_2|root:om_8`)
  );
});

test('different topics in one group map to different groups', () => {
  const a = sessionGroupFromEndpoint(`${GROUP_CHAT}|type:group|thread:omt_a`);
  const b = sessionGroupFromEndpoint(`${GROUP_CHAT}|type:group|thread:omt_b`);
  assert.notEqual(a, b);
  assert.notEqual(a, sessionGroupFromEndpoint(`${GROUP_CHAT}|type:group`));
});

test('isValidSessionGroup follows Core rules', () => {
  assert.ok(isValidSessionGroup('a'.repeat(SESSION_GROUP_MAX_LENGTH)));
  assert.ok(!isValidSessionGroup('a'.repeat(SESSION_GROUP_MAX_LENGTH + 1)));
  assert.ok(!isValidSessionGroup(''));
  assert.ok(!isValidSessionGroup('-x'));
  assert.ok(!isValidSessionGroup('a b'));
  assert.ok(!isValidSessionGroup(42));
});

// Total length = 'group-'(6) + chat + ':topic-'(7) + 'omt_x'(5)
const chatForLength = total => `oc_${'a'.repeat(total - 6 - 7 - 5 - 3)}`;

test('a 95-character name is accepted', () => {
  const name = sessionGroupFromEndpoint(`${chatForLength(95)}|type:group|thread:omt_x`);
  assert.equal(name.length, 95);
});

// T1': invalid input always throws - no guessing, rewriting or truncation
const INVALID = [
  ['empty endpoint', ''],
  ['bare chat id without type (never guessed)', CHAT],
  ['chat id with thread but no type', `${CHAT}|thread:${THREAD}`],
  ['unknown type', `${CHAT}|type:topic`],
  ['empty type', `${CHAT}|type:`],
  ['empty chat id', '|type:p2p'],
  ['chat id with a dot', 'oc_a.b|type:group'],
  ['chat id with a colon', 'oc_a:b|type:group'],
  ['chat id with @', 'oc_a@b|type:p2p'],
  ['chat id with a space', 'oc_a b|type:p2p'],
  ['chat id starting with -', '-oc_a|type:p2p'],
  ['empty thread', `${GROUP_CHAT}|type:group|thread:`],
  ['thread with illegal characters', `${GROUP_CHAT}|type:group|thread:omt_a/b`],
  ['thread with a colon', `${GROUP_CHAT}|type:group|thread:omt:a`],
  ['96-character name (not truncated)', `${chatForLength(96)}|type:group|thread:omt_x`],
];

for (const [label, endpoint] of INVALID) {
  test(`throws on ${label}`, () => {
    assert.throws(() => sessionGroupFromEndpoint(endpoint));
  });
}

test('throws on non-string input', () => {
  assert.throws(() => sessionGroupFromEndpoint(undefined));
  assert.throws(() => sessionGroupFromEndpoint(null));
});

// T2: query script agrees with the inbound mapping
const runScript = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('scripts/session-group.js prints the same group as the inbound mapping', () => {
  for (const [, endpoint, expected] of MAPPING) {
    const out = execFileSync(process.execPath, [SCRIPT, endpoint], { encoding: 'utf8' });
    assert.equal(out, `${sessionGroupFromEndpoint(endpoint)}\n`);
    assert.equal(out.trim(), expected);
  }
});

test('scripts/session-group.js exits 1 with empty stdout on bad usage or input', () => {
  const cases = [
    [],
    ['a', 'b'],
    [`${CHAT}|type:p2p`, 'extra'], // valid endpoint plus an extra argument
    [CHAT], // bare chat id: no type, never guessed
    [''],
    [`${CHAT}|type:topic`],
    [`${chatForLength(96)}|type:group|thread:omt_x`],
  ];
  for (const args of cases) {
    const r = runScript(...args);
    assert.equal(r.status, 1, `args ${JSON.stringify(args)}`);
    assert.equal(r.stdout, '', `args ${JSON.stringify(args)}`);
    assert.ok(r.stderr.length > 0, `args ${JSON.stringify(args)}`);
  }
});
