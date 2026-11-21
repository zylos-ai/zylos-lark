import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseRejectTarget, deliverRejectNotice } from '../src/lib/reject-notice.js';

function deps({ replyOk = true, replyThrows = false } = {}) {
  const calls = [];
  return {
    calls,
    replyToMessage: async (target, text, msgType, opts) => {
      calls.push(['reply', target, text, msgType, opts]);
      if (replyThrows) throw new Error('boom');
      return { success: replyOk };
    },
    sendMessage: async (chatId, text) => {
      calls.push(['send', chatId, text]);
      return { success: true };
    },
  };
}

test('p2p quote-reply (parent, no thread) base-sends instead of a silent reply-to', async () => {
  const d = deps();
  const ok = await deliverRejectNotice({ chatId: 'oc_dm', text: 'later', chatType: 'p2p', parentId: 'om_p', rootId: 'om_r', messageId: 'om_m' }, d);
  assert.equal(ok, true);
  assert.deepEqual(d.calls, [['send', 'oc_dm', 'later']]);
});

test('p2p plain message base-sends', async () => {
  const d = deps();
  await deliverRejectNotice({ chatId: 'oc_dm', text: 'later', chatType: 'p2p', messageId: 'om_m' }, d);
  assert.deepEqual(d.calls, [['send', 'oc_dm', 'later']]);
});

test('p2p topic thread replies in-thread to parent||root', async () => {
  const d = deps();
  await deliverRejectNotice({ chatId: 'oc_dm', text: 'later', chatType: 'p2p', parentId: 'om_p', rootId: 'om_r', threadId: 'omt_1', messageId: 'om_m' }, d);
  assert.deepEqual(d.calls, [['reply', 'om_p', 'later', 'text', { replyInThread: true }]]);
});

test('failed or throwing reply falls back to base send', async () => {
  for (const opt of [{ replyOk: false }, { replyThrows: true }]) {
    const d = deps(opt);
    const ok = await deliverRejectNotice({ chatId: 'oc_dm', text: 'x', chatType: 'p2p', rootId: 'om_r', threadId: 'omt_1' }, d);
    assert.equal(ok, true);
    assert.deepEqual(d.calls.map(c => c[0]), ['reply', 'send']);
  }
});

test('group routing is unchanged', () => {
  assert.equal(chooseRejectTarget({ chatType: 'group', parentId: 'om_p', rootId: 'om_r' }), 'om_p');
  assert.equal(chooseRejectTarget({ chatType: 'group', rootId: 'om_r' }), 'om_r');
  assert.equal(chooseRejectTarget({ chatType: 'group', threadId: 'omt_1', messageId: 'om_m' }), 'om_m');
  assert.equal(chooseRejectTarget({ chatType: 'group', messageId: 'om_m' }), null);
});

test('index.js wires reject notices through deliverRejectNotice with chatType', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.equal((src.match(/deliver: \(errMsg\) => sendRejectNotice\(chatId, errMsg, \{ chatType, parentId, rootId, threadId, messageId \}\)/g) || []).length, 2);
  assert.match(src, /import \{ deliverRejectNotice \} from '\.\/lib\/reject-notice\.js';/);
});
