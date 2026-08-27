/**
 * @-mention handling for the outbound send path.
 *
 * Two distinct jobs live in this module:
 *
 *   1. assembleMentions()          — the "compose" step (taskboard #47): turn a
 *                                    plain-text `@name` the model wrote into a
 *                                    real Lark `<at>` mention that notifies the
 *                                    person. GROUP chats only, single person only.
 *   2. convertAtMentionsForCard()  — the "translate" step: rewrite an assembled
 *                                    text-form `<at user_id=...>` into the
 *                                    card-native `<at id=...>` form for the card
 *                                    send path.
 *
 * assembleMentions runs FIRST (before the text/card fork in scripts/send.js), so
 * it only ever needs to produce ONE canonical form — Lark's official text form
 * `<at user_id="ou_xxx">Name</at>` (open.larksuite.com im-v1 message-content:
 * the `user_id` attribute accepts an open_id). The card path then defers to
 * convertAtMentionsForCard for the `<at id=ou_xxx></at>` translation. One
 * assembly code path, one tag shape.
 *
 * @-mention syntax conversion for interactive (card) messages.
 *
 * Lark accepts two different @-mention syntaxes, and which one is valid depends
 * on the message type:
 *
 *   text         <at user_id="ou_xxx">Display Name</at>   quoted id, display name kept
 *   interactive  <at id=ou_xxx></at>                      bare id, no display name
 *
 * scripts/send.js routes any message containing markdown through the card
 * (interactive) path. A caller writing the text-format mention — the form that
 * works everywhere else, and the only form documented for c4-send — therefore
 * reaches a card builder that does not understand it, and the tag renders as
 * literal text with no notification delivered. Messages without markdown were
 * unaffected, since they take the text path where the text form is native.
 *
 * This module converts text-format mentions to card-format so the card path
 * accepts them. Already-card-format tags carry no `user_id` attribute and are
 * left untouched, so running this over converted text is a no-op.
 */

// A text-format <at> tag. Deliberately broader than the minimum needed:
//
//   - the id may be double-quoted, single-quoted, or bare — a bare or
//     single-quoted id is just as valid in HTML-ish markup, and matching only
//     the double-quoted form would leave those mentions silently broken (the
//     exact failure this module exists to fix);
//   - other attributes may sit on either side of user_id;
//   - the display name is matched with [\s\S]*? so a name containing a newline
//     still terminates at the first </at> rather than swallowing the rest.
const AT_TEXT_TAG = /<at\s+[^>]*?user_id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>[\s\S]*?<\/at>/gi;

// Fenced blocks (``` … ```) and inline spans (` … `). Capturing, so String.split
// interleaves them into the result and they can be passed through verbatim.
const CODE_SPAN = /(```[\s\S]*?```|`[^`\n]*`)/g;

/**
 * Apply `fn` to every part of `text` that is NOT inside a code span.
 *
 * Without this, a message explaining the mention syntax — a fenced block
 * containing a literal `<at user_id="…">` — would itself be rewritten, silently
 * corrupting documentation and code samples. Conversion is a rendering
 * concession for the card API; it has no business editing quoted code.
 *
 * An unterminated fence matches nothing and is treated as ordinary text, which
 * keeps a stray backtick from disabling conversion for the rest of the message.
 */
function mapOutsideCode(text, fn) {
  return text
    .split(CODE_SPAN)
    .map((segment, i) => (i % 2 === 1 ? segment : fn(segment)))
    .join('');
}

/**
 * Rewrite text-format @-mentions into the card-format the interactive message
 * API expects. Returns the input unchanged when there is nothing to convert.
 *
 * @param {string} text
 * @returns {string}
 */
export function convertAtMentionsForCard(text) {
  if (typeof text !== 'string' || text === '') return text;
  if (!text.includes('<at')) return text;   // fast path: most messages have none

  return mapOutsideCode(text, (segment) =>
    segment.replace(AT_TEXT_TAG, (whole, doubleQuoted, singleQuoted, bare) => {
      const id = doubleQuoted ?? singleQuoted ?? bare;
      // An empty user_id ("") can't address anyone; leaving the tag as-is keeps
      // the original text visible rather than emitting a broken <at id=></at>.
      return id ? `<at id=${id}></at>` : whole;
    }),
  );
}

// ===========================================================================
// Mention assembly (taskboard #47): plain-text `@name` -> Lark <at> tag
// ===========================================================================
//
// Scope is deliberately narrow (owner decisions): ONLY the @-mention of a single
// person in a GROUP chat. No @all, no p2p/DM, no self-mention special-casing.
// Resolution is best-effort and never blocks a send: anything we cannot resolve
// (missing name, no members permission, API hiccup) is passed through verbatim,
// which is exactly the pre-existing behavior — the safe floor we never fall below.

import path from 'path';
import fs from 'fs';
import { DATA_DIR } from './config.js';

const REGISTRY_PATH = path.join(DATA_DIR, 'mention-registry.json');
const ROSTER_CACHE_DIR = path.join(DATA_DIR, 'roster-cache');
// Aligned with index.js's user-name cache TTL: a members roster older than this
// is refreshed on the next unresolved mention. A recorded no-permission result,
// by contrast, never expires (see resolveChatMembers) — owner decision 1 says a
// chat that returned no-permission must not be queried again.
const ROSTER_TTL_MS = 60 * 60 * 1000;
const MEMBERS_API_TIMEOUT_MS = 5000;

// Lark error codes that are a PERMANENT "this app/identity cannot read this
// chat's members" verdict — safe to remember and never re-query (owner
// decision 1). Verified against the lark skill refs (lark-im chat-members-list /
// chat-list / chat-search and lark-contact):
//   99991672 — bot (TAT) missing scope / permission denied (e.g. im:chat.members)
//   99991679 — user (UAT) not authorized for the scope
//   41050    — contact visibility-range / permission denied
// Everything else stays retryable. In particular 99991400 (rate limit / 频控) is
// TRANSIENT: caching it as no_permission would wrongly disable a chat forever, so
// it — like timeouts, network errors, and any unrecognized code — is NOT cached.
const PERMANENT_DENY_CODES = new Set([99991672, 99991679, 41050]);

// Protected regions the compose step must never touch: code (fenced + inline)
// and any already-formed <at> tag. Unlike mapOutsideCode (used by the card
// translator, which *wants* to see <at> tags), assembly must leave existing tags
// alone so it never double-wraps a mention the model already formatted.
const PROTECTED_SPAN =
  /(```[\s\S]*?```|`[^`\n]*`|<at\b[^>]*>[\s\S]*?<\/at>|<at\b[^>]*\/>)/gi;

function mapOutsideProtected(text, fn) {
  return text
    .split(PROTECTED_SPAN)
    .map((segment, i) => (i % 2 === 1 ? segment : fn(segment)))
    .join('');
}

// @all sentinels — owner decision 4: never assembled. Left as literal text.
const ALL_SENTINELS = ['all', 'everyone', '所有人'];

// A literal open_id written straight into the text (`@ou_...`). Unambiguously a
// single addressee, so it is wrapped directly without any lookup.
const OPEN_ID_RUN = /^ou_[A-Za-z0-9]+/;

// True when `c` would extend a name token, i.e. the match did not end on a
// boundary. Letters (incl. CJK) and digits always continue; `_`/`-` continue;
// `.` continues only when itself followed by a name char (so `gavin.yang` is one
// token, but a trailing sentence period is a boundary).
function continuesName(rest, idx) {
  const c = rest[idx];
  if (c === undefined) return false;
  if (/[A-Za-z0-9_-]/.test(c)) return true;
  if (c === '.') {
    const n = rest[idx + 1];
    return n !== undefined && /[A-Za-z0-9_-]/.test(n);
  }
  // Any other Unicode letter/number (e.g. a following CJK char) continues too.
  return /[\p{L}\p{N}]/u.test(c);
}

// Preceding-char guard: an `@` glued to a preceding word/path/version char is an
// email or file path or handle-in-a-word, never a mention (`foo@bar.com`,
// `path/@x`, `v1.2@3`). A mention's `@` sits at segment start or after
// whitespace/punctuation (incl. CJK punctuation, e.g. `谢谢@bob`).
function isMentionBoundary(prevChar) {
  if (prevChar === undefined || prevChar === '') return true;
  return !/[A-Za-z0-9_.+/-]/.test(prevChar);
}

/**
 * Build a resolver over the given name->openId map.
 *
 * Map construction order encodes owner decisions 2 & 3: registry entries are
 * added first and win over roster entries (registry-first), the first occurrence
 * of any name wins (take-first on collision), and matching is exact and
 * case-insensitive (strict — no fuzzy/prefix). Longest key wins so a name that
 * is a prefix of another (`gavin` vs `gavin.yang`) resolves to the longer one.
 */
function buildResolver(entries) {
  const map = new Map(); // lowercased name -> { openId, name }
  for (const { name, openId } of entries) {
    if (!name || !openId) continue;
    const key = name.toLowerCase();
    if (!map.has(key)) map.set(key, { openId, name });
  }
  const keysByLenDesc = [...map.keys()].sort((a, b) => b.length - a.length);

  return {
    /** Longest exact (case-insensitive) name match at the start of `rest`. */
    longestMatch(rest) {
      const lower = rest.toLowerCase();
      for (const key of keysByLenDesc) {
        if (lower.startsWith(key) && !continuesName(rest, key.length)) {
          return { ...map.get(key), len: key.length };
        }
      }
      return null;
    },
  };
}

/**
 * Rewrite `@name` tokens in a single protected-free segment.
 *
 * Returns the rewritten segment and the list of name-like tokens that looked
 * like a mention but did not resolve (used to decide whether a members lookup is
 * worthwhile, and for logging).
 */
function rewriteSegment(segment, resolver, { botOpenId } = {}) {
  let out = '';
  let i = 0;
  const unresolved = [];

  while (i < segment.length) {
    const at = segment.indexOf('@', i);
    if (at === -1) {
      out += segment.slice(i);
      break;
    }
    out += segment.slice(i, at);

    if (!isMentionBoundary(at > 0 ? segment[at - 1] : '')) {
      out += '@';
      i = at + 1;
      continue;
    }

    const rest = segment.slice(at + 1);

    // @all / @everyone / @所有人 — owner decision 4: never assembled.
    const sentinel = ALL_SENTINELS.find(
      (s) => rest.toLowerCase().startsWith(s) && !continuesName(rest, s.length),
    );
    if (sentinel) {
      out += '@';
      i = at + 1;
      continue;
    }

    // A registered / roster name (strict, longest, case-insensitive).
    const hit = resolver.longestMatch(rest);
    if (hit) {
      // Owner decision 6: a bot @-ing itself is noise — leave it as plain text.
      // Only active when the caller supplied the bot's own open_id.
      if (botOpenId && hit.openId === botOpenId) {
        out += '@' + rest.slice(0, hit.len);
      } else {
        out += `<at user_id="${hit.openId}">${hit.name}</at>`;
      }
      i = at + 1 + hit.len;
      continue;
    }

    // A literal `@ou_...` open_id: wrap directly, no lookup needed — but only a
    // COMPLETE, boundaried token. Without the boundary check, `@ou_abc-foo` or
    // `@ou_abc_123` would wrap a truncated id (`ou_abc`) and notify the wrong
    // object; a trailing name char means it is not a clean open_id, so leave it.
    const idMatch = rest.match(OPEN_ID_RUN);
    if (idMatch && !continuesName(rest, idMatch[0].length)) {
      out += `<at user_id="${idMatch[0]}"></at>`;
      i = at + 1 + idMatch[0].length;
      continue;
    }

    // Looks like a name we could not resolve: record it, leave text untouched.
    if (/^[\p{L}\p{N}]/u.test(rest)) {
      const token = (rest.match(/^[\p{L}\p{N}._-]+/u) || [''])[0];
      if (token) unresolved.push(token);
    }
    out += '@';
    i = at + 1;
  }

  return { out, unresolved };
}

// -- default IO (real files + live API), all overridable for tests -----------

function defaultLoadRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function rosterCachePath(chatId) {
  const safe = String(chatId).replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(ROSTER_CACHE_DIR, `${safe}.json`);
}

function defaultReadRosterCache(chatId) {
  try {
    return JSON.parse(fs.readFileSync(rosterCachePath(chatId), 'utf8'));
  } catch {
    return null;
  }
}

function defaultWriteRosterCache(chatId, record) {
  try {
    fs.mkdirSync(ROSTER_CACHE_DIR, { recursive: true });
    const target = rosterCachePath(chatId);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, target);
  } catch {
    // Caching is an optimization; failure to persist is non-fatal.
  }
}

async function defaultFetchMembers(chatId) {
  // Dynamic import keeps the Lark SDK (pulled in via chat.js -> client.js) out
  // of the module load path, so the pure compose/translate logic stays testable
  // without credentials. Raced against a timeout: a hung members call must never
  // stall the send (owner decision 1: non-blocking).
  let timer;
  try {
    const { listChatMembers } = await import('./chat.js');
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ success: false, timeout: true }), MEMBERS_API_TIMEOUT_MS);
    });
    return await Promise.race([listChatMembers(chatId, 'open_id'), timeout]);
  } catch (err) {
    return { success: false, message: err?.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the roster entries for a chat, honoring owner decision 1:
 *   - a recorded no-permission result short-circuits — never re-query;
 *   - a fresh cached roster is used as-is — no API call;
 *   - otherwise (and only when the text has an unresolved name) fetch once,
 *     then persist: the roster on success, a permanent no-permission marker on a
 *     hard API rejection. A timeout / transient error is NOT cached, so it can be
 *     retried on the next message.
 * Returns { entries } where entries is an array of { name, openId }.
 */
async function resolveChatMembers(chatId, needFetch, io) {
  const cached = io.readRosterCache(chatId);

  if (cached?.status === 'no_permission') return { entries: [] };

  const fresh =
    cached?.status === 'ok' &&
    Array.isArray(cached.members) &&
    io.now() - (cached.fetchedAt || 0) < ROSTER_TTL_MS;

  const cachedEntries = cached?.status === 'ok' && Array.isArray(cached.members) ? cached.members : [];

  // Use the cache when it is fresh, or whenever there is nothing left to look up.
  if (fresh || !needFetch) return { entries: cachedEntries };

  const result = await io.fetchMembers(chatId);

  if (result?.success && Array.isArray(result.members)) {
    const entries = result.members
      .filter((m) => m?.name && m?.memberId)
      .map((m) => ({ name: m.name, openId: m.memberId }));
    io.writeRosterCache(chatId, { status: 'ok', fetchedAt: io.now(), members: entries });
    return { entries };
  }

  // ONLY a known permanent permission-denied code is remembered so we never
  // query this chat again. Rate limits (99991400), timeouts, network errors, and
  // any unrecognized code are left uncached and remain retryable next message.
  if (result && !result.success && PERMANENT_DENY_CODES.has(result.code)) {
    io.writeRosterCache(chatId, { status: 'no_permission', code: result.code, recordedAt: io.now() });
    return { entries: cachedEntries };
  }

  return { entries: cachedEntries };
}

/**
 * Assemble plain-text `@name` mentions into Lark's official text-form `<at>`
 * tags. Best-effort and non-blocking: returns the input unchanged on anything it
 * cannot handle, and never throws.
 *
 * @param {string} text                 Outbound message text.
 * @param {object} endpoint             Parsed endpoint ({ chatId, type, ... }).
 * @param {object} [io]                 Injectable IO (registry / roster cache /
 *                                      members fetch / clock / botOpenId / log).
 * @returns {Promise<string>}
 */
export async function assembleMentions(text, endpoint, io = {}) {
  if (typeof text !== 'string' || text === '' || !text.includes('@')) return text;
  // Owner decision 5: p2p DMs (and any non-group endpoint) bypass entirely.
  if (!endpoint || endpoint.type !== 'group') return text;

  const resolved = {
    loadRegistry: io.loadRegistry || defaultLoadRegistry,
    readRosterCache: io.readRosterCache || defaultReadRosterCache,
    writeRosterCache: io.writeRosterCache || defaultWriteRosterCache,
    fetchMembers: io.fetchMembers || defaultFetchMembers,
    now: io.now || (() => Date.now()),
    botOpenId: io.botOpenId,
    log: io.log || ((msg) => console.log(msg)),
  };

  try {
    const chatId = endpoint.chatId;
    const registry = resolved.loadRegistry() || {};
    const registryEntries = Object.entries(registry)
      .filter(([, v]) => v && v.open_id)
      .map(([name, v]) => ({ name, openId: v.open_id }));

    // First pass over registry only: what still looks like an unresolved name?
    // (Determines whether a members lookup is even worth doing.)
    let resolver = buildResolver(registryEntries);
    let needFetch = false;
    mapOutsideProtected(text, (seg) => {
      const { unresolved } = rewriteSegment(seg, resolver, resolved);
      if (unresolved.length) needFetch = true;
      return seg;
    });

    // Layer in the chat roster (cache-first, one API call at most — see
    // resolveChatMembers) when there is something registry could not resolve.
    if (needFetch && chatId) {
      const { entries } = await resolveChatMembers(chatId, needFetch, resolved);
      if (entries.length) resolver = buildResolver([...registryEntries, ...entries]);
    }

    // Final pass: actually rewrite, and log whatever is still unresolved.
    const result = mapOutsideProtected(text, (seg) => {
      const { out, unresolved } = rewriteSegment(seg, resolver, resolved);
      for (const name of unresolved) resolved.log(`[lark] mention unresolved: @${name}`);
      return out;
    });
    return result;
  } catch (err) {
    // Non-blocking contract: never let mention assembly break a send.
    resolved.log(`[lark] mention assembly skipped: ${err?.message}`);
    return text;
  }
}
