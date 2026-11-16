import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBotIdentity,
  explainBotInfoError,
  UNKNOWN_LOG_INTERVAL_MS,
} from '../src/lib/bot-identity.js';

const APP_ID = 'cli_current';
const FETCHED = { success: true, open_id: 'ou_fetched', app_name: 'TestBot' };
const FAILED = { success: false, message: 'network down' };

// Mirrors isBotMentioned in src/index.js: mention matches the identity's open_id.
function mentionsBot(identity, mentionId) {
  return Boolean(identity.openId) && mentionId === identity.openId;
}

function setup({ results = [], appId = APP_ID, fetchImpl, ...overrides } = {}) {
  const calls = [];
  const persisted = [];
  const changes = [];
  const logs = [];
  const errors = [];
  let index = 0;
  const fetchBotInfo = fetchImpl || (async () => {
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    if (result instanceof Error) throw result;
    return result;
  });
  const identity = createBotIdentity({
    fetchBotInfo: async () => {
      calls.push(Date.now());
      return fetchBotInfo();
    },
    appId,
    persist: (value) => persisted.push(value),
    onChange: (value) => changes.push(value),
    log: (msg) => logs.push(msg),
    logError: (msg) => errors.push(msg),
    ...overrides,
  });
  return { identity, calls, persisted, changes, logs, errors };
}

function groupMessage(identity) {
  return identity.ensureForMessage();
}

test('uses cached identity when cached app_id matches the current app', () => {
  const { identity, calls } = setup();
  assert.equal(identity.loadCached({ open_id: 'ou_cached', app_id: APP_ID }), true);
  assert.equal(identity.openId, 'ou_cached');
  assert.equal(identity.status().status, 'cached');
  assert.equal(mentionsBot(identity, 'ou_cached'), true);
  assert.equal(calls.length, 0);
});

test('uses cached identity from an older config without app_id', () => {
  const { identity } = setup();
  assert.equal(identity.loadCached({ open_id: 'ou_cached' }), true);
  assert.equal(identity.status().status, 'cached');
  assert.equal(identity.openId, 'ou_cached');
});

test('ignores cached identity whose app_id differs from the current app', () => {
  const { identity } = setup();
  assert.equal(identity.loadCached({ open_id: 'ou_other', app_id: 'cli_other' }), false);
  assert.equal(identity.openId, '');
  assert.equal(identity.status().status, 'unknown');
});

test('successful startup fetch writes back open_id and app_id', async () => {
  const { identity, calls, persisted, changes } = setup({ results: [FETCHED] });
  await identity.fetchAtStartup();
  assert.equal(calls.length, 1);
  assert.equal(identity.openId, 'ou_fetched');
  assert.equal(identity.appName, 'TestBot');
  assert.equal(identity.status().status, 'fetched');
  assert.deepEqual(persisted, [{ openId: 'ou_fetched', appId: APP_ID }]);
  assert.deepEqual(changes.at(-1), { openId: 'ou_fetched', appName: 'TestBot', appId: APP_ID });
  await groupMessage(identity);
  assert.equal(calls.length, 1);
});

test('fetched value overrides a different cached value', async () => {
  const { identity, persisted, logs } = setup({ results: [FETCHED] });
  identity.loadCached({ open_id: 'ou_stale', app_id: APP_ID });
  await identity.fetchAtStartup();
  assert.equal(identity.openId, 'ou_fetched');
  assert.equal(identity.status().status, 'fetched');
  assert.deepEqual(persisted, [{ openId: 'ou_fetched', appId: APP_ID }]);
  assert.ok(logs.some((l) => l.includes('differs from fetched')));
});

test('startup failure with cached identity never refetches', async () => {
  const { identity, calls } = setup({ results: [FAILED, FETCHED] });
  identity.loadCached({ open_id: 'ou_cached', app_id: APP_ID });
  await identity.fetchAtStartup();
  await groupMessage(identity);
  await groupMessage(identity);
  assert.equal(calls.length, 1);
  assert.equal(identity.status().status, 'cached');
  assert.equal(mentionsBot(identity, 'ou_cached'), true);
  identity.stop();
});

test('startup failure without cache: first message refetches and recovers before the mention check', async () => {
  const { identity, calls, persisted, logs } = setup({ results: [FAILED, FETCHED] });
  await identity.fetchAtStartup();
  assert.equal(identity.status().status, 'unknown');
  assert.equal(mentionsBot(identity, 'ou_fetched'), false);

  await groupMessage(identity);
  assert.equal(calls.length, 2);
  assert.equal(identity.status().status, 'fetched');
  assert.equal(identity.status().refetchUsed, true);
  assert.equal(mentionsBot(identity, 'ou_fetched'), true);
  assert.deepEqual(persisted, [{ openId: 'ou_fetched', appId: APP_ID }]);
  assert.ok(logs.some((l) => l.includes('recovered on first message')));

  await groupMessage(identity);
  assert.equal(calls.length, 2);
});

test('failed refetch is never retried: getBotInfo call count stays at 2', async () => {
  const { identity, calls, errors } = setup({ results: [FAILED, FAILED, FETCHED] });
  await identity.fetchAtStartup();
  await groupMessage(identity);
  await groupMessage(identity);
  await groupMessage(identity);
  assert.equal(calls.length, 2);
  assert.equal(identity.status().attempts, 2);
  assert.equal(identity.status().status, 'unknown');
  assert.ok(errors.some((e) => e.includes('no further attempts')));
  identity.stop();
});

test('thrown fetch errors count as failures and are not retried', async () => {
  const { identity, calls } = setup({ results: [new Error('boom'), new Error('boom'), FETCHED] });
  await identity.fetchAtStartup();
  await groupMessage(identity);
  await groupMessage(identity);
  assert.equal(calls.length, 2);
  assert.equal(identity.status().status, 'unknown');
  identity.stop();
});

test('concurrent messages share one refetch request', async () => {
  let release;
  let count = 0;
  const { identity, calls } = setup({
    fetchImpl: async () => {
      count += 1;
      if (count === 1) return FAILED;
      await new Promise((resolve) => { release = resolve; });
      return FETCHED;
    },
  });
  await identity.fetchAtStartup();
  const pending = [groupMessage(identity), groupMessage(identity), groupMessage(identity)];
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all(pending);
  assert.equal(calls.length, 2);
  assert.equal(identity.openId, 'ou_fetched');
});

test('message arriving while the startup fetch is in flight waits for it instead of a parallel request', async () => {
  let release;
  let count = 0;
  const { identity, calls } = setup({
    fetchImpl: async () => {
      count += 1;
      if (count === 1) {
        await new Promise((resolve) => { release = resolve; });
        return FETCHED;
      }
      return FETCHED;
    },
  });
  const startup = identity.fetchAtStartup();
  const message = groupMessage(identity);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([startup, message]);
  assert.equal(calls.length, 1);
  assert.equal(identity.status().status, 'fetched');
});

test('refetch wait is bounded by the timeout and still only one request is made', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let release;
  let count = 0;
  const { identity, calls, errors } = setup({
    refetchTimeoutMs: 5_000,
    fetchImpl: async () => {
      count += 1;
      if (count === 1) return FAILED;
      await new Promise((resolve) => { release = resolve; });
      return FETCHED;
    },
  });
  await identity.fetchAtStartup();
  const first = groupMessage(identity);
  await Promise.resolve();
  t.mock.timers.tick(5_000);
  await first;
  assert.equal(identity.status().status, 'unknown');
  assert.ok(errors.some((e) => e.includes('still pending')));

  await groupMessage(identity);
  assert.equal(calls.length, 2);

  // A late success still applies the identity.
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(identity.status().status, 'fetched');
  assert.equal(calls.length, 2);
  identity.stop();
});

test('logs an error every 10 minutes while identity is unknown, without requests', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { identity, calls, errors } = setup({ results: [FAILED, FAILED] });
  await identity.fetchAtStartup();
  await groupMessage(identity);
  const before = errors.filter((e) => e.includes('unknown for')).length;
  assert.equal(before, 0);

  t.mock.timers.tick(UNKNOWN_LOG_INTERVAL_MS);
  t.mock.timers.tick(UNKNOWN_LOG_INTERVAL_MS);
  t.mock.timers.tick(UNKNOWN_LOG_INTERVAL_MS);
  const periodic = errors.filter((e) => e.includes('unknown for'));
  assert.equal(periodic.length, 3);
  assert.match(periodic[2], /unknown for 30m/);
  assert.equal(calls.length, 2);
  identity.stop();
});

test('periodic unknown log stops once the identity is recovered', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { identity, errors } = setup({ results: [FAILED, FETCHED] });
  await identity.fetchAtStartup();
  await groupMessage(identity);
  t.mock.timers.tick(UNKNOWN_LOG_INTERVAL_MS * 3);
  assert.equal(errors.filter((e) => e.includes('unknown for')).length, 0);
});

test('status() exposes the health fields', async () => {
  const { identity } = setup({ results: [FAILED, FETCHED] });
  const initial = identity.status();
  assert.deepEqual(Object.keys(initial).sort(), ['attempts', 'refetchUsed', 'since', 'status']);
  assert.equal(initial.status, 'unknown');
  assert.equal(initial.attempts, 0);
  assert.equal(initial.refetchUsed, false);
  assert.ok(!Number.isNaN(Date.parse(initial.since)));

  await identity.fetchAtStartup();
  assert.equal(identity.status().attempts, 1);
  await groupMessage(identity);
  const recovered = identity.status();
  assert.equal(recovered.status, 'fetched');
  assert.equal(recovered.attempts, 2);
  assert.equal(recovered.refetchUsed, true);
  assert.equal(JSON.stringify(recovered).includes('ou_fetched'), false);
});

test('explains the SDK token destructuring error once', () => {
  const raw = "Cannot destructure property 'tenant_access_token' of '(intermediate value)' as it is undefined.";
  const explained = explainBotInfoError(raw);
  assert.match(explained, /network unreachable or bad app credentials/);
  assert.equal(explainBotInfoError(explained), explained);
  assert.equal(explainBotInfoError('API error: forbidden'), 'API error: forbidden');
});
