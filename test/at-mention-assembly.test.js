import test from 'node:test';
import assert from 'node:assert/strict';

import { assembleMentions, convertAtMentionsForCard } from '../src/lib/at-mention.js';

// Mention assembly (taskboard #47): plain-text `@name` -> Lark <at> tag, in
// GROUP chats only, single person only. These exercise assembleMentions with an
// injected IO layer so no filesystem or Lark API is touched.

const GROUP = { chatId: 'oc_1', type: 'group' };
const P2P = { chatId: 'ou_dm', type: 'p2p' };

// Registry fixture: names -> { open_id, type }.
const REGISTRY = {
  'gavin.yang': { open_id: 'ou_gavin', type: 'user' },
  'Justin Zhang': { open_id: 'ou_justin', type: 'user' },
  'zylos0t': { open_id: 'ou_bot_self', type: 'bot' },
};

// Build an injectable IO. `members` seeds an in-memory roster cache/API and
// `fetchCalls` counts how often the (fake) members API is hit.
function makeIO({ registry = REGISTRY, members = null, permission = true, botOpenId } = {}) {
  const cache = new Map(); // chatId -> record
  const state = { fetchCalls: 0 };
  return {
    loadRegistry: () => registry,
    readRosterCache: (chatId) => cache.get(chatId) || null,
    writeRosterCache: (chatId, record) => cache.set(chatId, record),
    fetchMembers: async (chatId) => {
      state.fetchCalls++;
      if (!permission) return { success: false, code: 99991672, message: 'no permission' };
      return {
        success: true,
        members: (members || []).map((m) => ({ name: m.name, memberId: m.openId })),
      };
    },
    now: () => 1_000_000,
    botOpenId,
    log: () => {},
    _state: state,
    _cache: cache,
  };
}

// --- decision 1: registry resolution, no API call needed --------------------

test('group @name resolved via registry -> text-form <at>', async () => {
  const io = makeIO();
  const out = await assembleMentions('hey @gavin.yang please look', GROUP, io);
  assert.equal(out, 'hey <at user_id="ou_gavin">gavin.yang</at> please look');
  assert.equal(io._state.fetchCalls, 0, 'registry hit must not touch the members API');
});

// --- decision 1: resolution via members cache / API -------------------------

test('group @name resolved via members lookup when absent from registry', async () => {
  const io = makeIO({ members: [{ name: 'nicholas.hu', openId: 'ou_nick' }] });
  const out = await assembleMentions('cc @nicholas.hu', GROUP, io);
  assert.equal(out, 'cc <at user_id="ou_nick">nicholas.hu</at>');
  assert.equal(io._state.fetchCalls, 1, 'one members lookup');
});

test('a fresh roster cache is reused without a second API call', async () => {
  const io = makeIO({ members: [{ name: 'nicholas.hu', openId: 'ou_nick' }] });
  await assembleMentions('@nicholas.hu', GROUP, io); // populates cache
  await assembleMentions('@nicholas.hu again', GROUP, io);
  assert.equal(io._state.fetchCalls, 1, 'fresh cache must not re-query');
});

test('registry hit alone never triggers a members lookup', async () => {
  const io = makeIO({ members: [{ name: 'x', openId: 'ou_x' }] });
  await assembleMentions('@gavin.yang hi', GROUP, io);
  assert.equal(io._state.fetchCalls, 0);
});

// --- decision 2: registry-first, then take-first on collision ---------------

test('registry wins over a roster entry of the same name', async () => {
  const io = makeIO({
    registry: { alex: { open_id: 'ou_reg_alex' } },
    members: [{ name: 'alex', openId: 'ou_roster_alex' }],
  });
  const out = await assembleMentions('@alex', GROUP, io);
  assert.equal(out, '<at user_id="ou_reg_alex">alex</at>');
});

test('collision with no registry entry takes the first roster match', async () => {
  const io = makeIO({
    registry: {},
    members: [
      { name: 'alex', openId: 'ou_first' },
      { name: 'Alex', openId: 'ou_second' },
    ],
  });
  const out = await assembleMentions('@alex', GROUP, io);
  assert.equal(out, '<at user_id="ou_first">alex</at>');
});

// --- decision 3: strict matching (no fuzzy / prefix false rewrites) ---------

test('strict match: an unknown name is passed through unchanged', async () => {
  const io = makeIO({ members: [] });
  const out = await assembleMentions('ping @unknown.person now', GROUP, io);
  assert.equal(out, 'ping @unknown.person now');
});

test('strict match: a prefix of a known name is NOT rewritten', async () => {
  // "gavin" is a prefix of registry key "gavin.yang" but not itself a key.
  const io = makeIO({ members: [] });
  const out = await assembleMentions('@gavinx', GROUP, io);
  assert.equal(out, '@gavinx');
});

test('longest match wins: gavin.yang resolves as a whole', async () => {
  const io = makeIO({ registry: { gavin: { open_id: 'ou_g' }, 'gavin.yang': { open_id: 'ou_gy' } } });
  const out = await assembleMentions('@gavin.yang', GROUP, io);
  assert.equal(out, '<at user_id="ou_gy">gavin.yang</at>');
});

test('a name with a space (dictionary key) resolves without swallowing the next word', async () => {
  const io = makeIO();
  const out = await assembleMentions('@Justin Zhang thanks', GROUP, io);
  assert.equal(out, '<at user_id="ou_justin">Justin Zhang</at> thanks');
});

test('trailing sentence punctuation is a boundary, not part of the name', async () => {
  const io = makeIO();
  const out = await assembleMentions('ok @gavin.yang.', GROUP, io);
  assert.equal(out, 'ok <at user_id="ou_gavin">gavin.yang</at>.');
});

// --- decision 1: no-permission -> pass-through + never re-query -------------

test('a KNOWN permission code (99991672) -> permanent no_permission, no re-query', async () => {
  const io = makeIO({ permission: false }); // fetchMembers returns code 99991672
  const out1 = await assembleMentions('@someone', GROUP, io);
  assert.equal(out1, '@someone');
  assert.equal(io._state.fetchCalls, 1, 'first attempt hits the API once');
  assert.equal(io._cache.get('oc_1')?.status, 'no_permission');

  const out2 = await assembleMentions('@someone else', GROUP, io);
  assert.equal(out2, '@someone else');
  assert.equal(io._state.fetchCalls, 1, 'a chat that returned no-permission must never be queried again');
});

test('a RATE LIMIT (99991400) is transient: NOT cached, re-fetched on a later message', async () => {
  const io = makeIO();
  io.fetchMembers = async () => {
    io._state.fetchCalls++;
    return { success: false, code: 99991400, message: 'frequency limit' };
  };
  const out = await assembleMentions('@ghost', GROUP, io);
  assert.equal(out, '@ghost', 'still non-blocking: unresolved passes through');
  assert.equal(io._cache.get('oc_1'), undefined, 'a rate limit must not be persisted as no_permission');
  await assembleMentions('@ghost again', GROUP, io);
  assert.equal(io._state.fetchCalls, 2, 'rate-limited chat is retried on the next message');
});

test('an unrecognized error code is treated as transient, not permanent', async () => {
  const io = makeIO();
  io.fetchMembers = async () => {
    io._state.fetchCalls++;
    return { success: false, code: 130002, message: 'internal error' };
  };
  await assembleMentions('@ghost', GROUP, io);
  await assembleMentions('@ghost', GROUP, io);
  assert.equal(io._cache.get('oc_1'), undefined, 'unknown codes are not cached as no_permission');
  assert.equal(io._state.fetchCalls, 2, 'unknown coded failures remain retryable');
});

test('a members timeout is transient: not cached, retried next time', async () => {
  const io = makeIO();
  io.fetchMembers = async () => {
    io._state.fetchCalls++;
    return { success: false, timeout: true };
  };
  await assembleMentions('@ghost', GROUP, io);
  await assembleMentions('@ghost', GROUP, io);
  assert.equal(io._state.fetchCalls, 2, 'transient failures are retryable (no marker cached)');
});

// --- decision 5: p2p / DM -> no assembly ------------------------------------

test('p2p endpoint bypasses assembly entirely', async () => {
  const io = makeIO();
  const out = await assembleMentions('@gavin.yang in a DM', P2P, io);
  assert.equal(out, '@gavin.yang in a DM');
  assert.equal(io._state.fetchCalls, 0);
});

test('an endpoint with no type is treated as non-group and bypassed', async () => {
  const io = makeIO();
  const out = await assembleMentions('@gavin.yang', { chatId: 'oc_x' }, io);
  assert.equal(out, '@gavin.yang');
});

// --- decision 4: @all -> not handled ----------------------------------------

test('@all / @everyone / @所有人 are never assembled', async () => {
  const io = makeIO();
  for (const s of ['@all', '@everyone', '@所有人']) {
    assert.equal(await assembleMentions(`${s} heads up`, GROUP, io), `${s} heads up`);
  }
  assert.equal(io._state.fetchCalls, 0, '@all must not even trigger a members lookup');
});

test('@allen is a name, not the @all sentinel', async () => {
  const io = makeIO({ registry: { allen: { open_id: 'ou_allen' } } });
  const out = await assembleMentions('@allen', GROUP, io);
  assert.equal(out, '<at user_id="ou_allen">allen</at>');
});

// --- decision 6: self-mention -> skipped ------------------------------------

// In production send.js now always passes botOpenId (persisted to config by
// index.js at startup), so the self-suppression branch is live, not dormant.

test('with botOpenId set (prod), the bot @-ing itself is left as plain text', async () => {
  const io = makeIO({ botOpenId: 'ou_bot_self' });
  const out = await assembleMentions('note @zylos0t here', GROUP, io);
  assert.equal(out, 'note @zylos0t here');
});

test('suppression is self-only: with botOpenId set, other names still assemble', async () => {
  const io = makeIO({ botOpenId: 'ou_bot_self' });
  const out = await assembleMentions('@gavin.yang please', GROUP, io);
  assert.equal(out, '<at user_id="ou_gavin">gavin.yang</at> please');
});

test('graceful fallback: with no botOpenId, assembly still runs (no self data to suppress)', async () => {
  const io = makeIO();
  const out = await assembleMentions('@gavin.yang', GROUP, io);
  assert.equal(out, '<at user_id="ou_gavin">gavin.yang</at>');
});

// --- false-positive avoidance -----------------------------------------------

test('an email address is never treated as a mention', async () => {
  const io = makeIO();
  const out = await assembleMentions('mail gavin.yang@example.com now', GROUP, io);
  assert.equal(out, 'mail gavin.yang@example.com now');
});

test('an @name inside a code span is left untouched', async () => {
  const io = makeIO();
  const out = await assembleMentions('run `notify @gavin.yang` please', GROUP, io);
  assert.equal(out, 'run `notify @gavin.yang` please');
});

test('an @name inside a fenced code block is left untouched', async () => {
  const io = makeIO();
  const doc = '```\n@gavin.yang\n```';
  assert.equal(await assembleMentions(doc, GROUP, io), doc);
});

test('an already-formed <at> tag is not re-wrapped', async () => {
  const io = makeIO();
  const pre = 'hi <at user_id="ou_gavin">gavin.yang</at> there';
  assert.equal(await assembleMentions(pre, GROUP, io), pre);
});

// --- literal @open_id -------------------------------------------------------

test('a literal @ou_... open_id is wrapped directly without a lookup', async () => {
  const io = makeIO();
  const out = await assembleMentions('poke @ou_abc123 now', GROUP, io);
  assert.equal(out, 'poke <at user_id="ou_abc123"></at> now');
  assert.equal(io._state.fetchCalls, 0);
});

test('a clean @ou_ token ending on sentence punctuation is still wrapped', async () => {
  const io = makeIO();
  const out = await assembleMentions('poke @ou_abc123.', GROUP, io);
  assert.equal(out, 'poke <at user_id="ou_abc123"></at>.');
});

test('a literal @ou_ token with a trailing hyphen is NOT wrapped (no truncation)', async () => {
  // Without a boundary check this became <at user_id="ou_abc"></at>-foo,
  // wrapping a truncated id and notifying the wrong object.
  const io = makeIO();
  const out = await assembleMentions('see @ou_abc-foo end', GROUP, io);
  assert.equal(out, 'see @ou_abc-foo end');
});

test('a literal @ou_ token with a trailing underscore is NOT wrapped (no truncation)', async () => {
  const io = makeIO();
  const out = await assembleMentions('@ou_abc_123', GROUP, io);
  assert.equal(out, '@ou_abc_123');
});

// --- decision 7: canonical output format per message type -------------------

test('assembly emits the official text form; the card translator yields card form', async () => {
  const io = makeIO();
  const assembled = await assembleMentions('@gavin.yang review', GROUP, io);
  // Text path: native text form, per open.larksuite.com im-v1 spec.
  assert.equal(assembled, '<at user_id="ou_gavin">gavin.yang</at> review');
  // Card path: existing translator converts to the card-native form.
  assert.equal(convertAtMentionsForCard(assembled), '<at id=ou_gavin></at> review');
});

// --- robustness -------------------------------------------------------------

test('non-string / empty / mention-free input is returned unchanged', async () => {
  const io = makeIO();
  assert.equal(await assembleMentions('', GROUP, io), '');
  assert.equal(await assembleMentions(null, GROUP, io), null);
  assert.equal(await assembleMentions('no at signs here', GROUP, io), 'no at signs here');
});

test('a throwing IO never breaks the send — original text is returned', async () => {
  const io = makeIO();
  io.loadRegistry = () => {
    throw new Error('boom');
  };
  const out = await assembleMentions('@gavin.yang', GROUP, io);
  assert.equal(out, '@gavin.yang');
});
