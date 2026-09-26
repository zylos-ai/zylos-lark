/**
 * Unit tests for the half-open watchdog and restart rate limit, on a FAKE
 * clock with a FAKE WSClient.
 *
 * What these cover: watchdog decision logic (pong tracking, late WARN,
 * timeout -> exactly one restart request, never restart without a pong,
 * config parsing), the restart sequence (close, onShutdown hook, exit code,
 * hard deadline when cleanup hangs), the persisted rate limit (limit, window
 * expiry, corrupt / missing / unwritable state file, atomic write) and the
 * /health fields.
 *
 * What these do NOT cover (the fake WSClient only models start/close/pong):
 * real SDK reconnect closures and DataCache timers. Those are covered with
 * the real @larksuiteoapi/node-sdk WSClient in test/ws-real-sdk.test.js
 * (in-process) and test/ws-restart-process.test.js (real child processes
 * exiting and being restarted by a PM2 stand-in). The cross-process lock is
 * covered by test/restart-guard-lock.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  createWebSocketTransport,
  parsePongTimeout,
  WATCHDOG_TICK_MS,
  SUMMARY_INTERVAL_MS,
  DEFAULT_PING_INTERVAL_MS,
  RESTART_DEADLINE_MS,
  RESTART_EXIT_CODE,
  RESTART_MAX_IN_WINDOW,
  RESTART_WINDOW_MS,
} from '../src/lib/transport/websocket.js';
import { createRestartGuard, CORRUPT_REASON } from '../src/lib/transport/restart-guard.js';

const INTERVAL = DEFAULT_PING_INTERVAL_MS; // 120s
const TIMEOUT = 3 * INTERVAL; // 360s

// ---------- fake clock ----------
function createClock(start = 1_000_000_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  const add = (fn, ms, repeat) => {
    const id = ++seq;
    timers.set(id, { fn, at: t + ms, ms, repeat });
    return { id, unref() { return this; } };
  };
  const clear = (h) => { if (h) timers.delete(h.id); };
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  return {
    now: () => t,
    setTimeoutFn: (fn, ms) => add(fn, ms, false),
    setIntervalFn: (fn, ms) => add(fn, ms, true),
    clearTimeoutFn: clear,
    clearIntervalFn: clear,
    pending: () => timers.size,
    flush,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, tm] of timers) if (tm.at <= end && (!next || tm.at < next[1].at)) next = [id, tm];
        if (!next) break;
        const [id, tm] = next;
        t = tm.at;
        if (tm.repeat) tm.at += tm.ms; else timers.delete(id);
        tm.fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

// ---------- fake SDK ----------
function createFakeSdk() {
  const clients = [];
  class FakeWSClient {
    constructor(params) {
      this.params = params;
      this.closed = 0;
      this.wsInstance = null;
      this.pingInterval = INTERVAL;
      this.controlFrames = 0;
      const self = this;
      this.wsConfig = {
        getWS: (k) => (k === 'pingInterval' ? self.pingInterval : undefined),
        getWSInstance: () => self.wsInstance,
        setWSInstance: (ws) => { self.wsInstance = ws; },
      };
      clients.push(this);
    }
    async handleControlData() { this.controlFrames++; }
    async start() { this.wsConfig.setWSInstance({ readyState: 1 }); }
    close() { this.closed++; this.wsInstance = null; }
    pong() {
      return this.handleControlData({ headers: [{ key: 'type', value: 'pong' }], payload: new Uint8Array() });
    }
  }
  class FakeDispatcher { register() { return this; } }
  return { clients, FakeWSClient, FakeDispatcher };
}

function createLog() {
  const lines = { log: [], warn: [], error: [] };
  return {
    lines,
    log: (m) => lines.log.push(m),
    warn: (m) => lines.warn.push(m),
    error: (m) => lines.error.push(m),
    all: () => [...lines.log, ...lines.warn, ...lines.error],
  };
}

function tmpStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-ws-test-'));
  return path.join(dir, 'ws-restart-state.json');
}

function readState(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function setup({ config = { domain: 'lark' }, stateFile = tmpStateFile(), onShutdown, fsImpl, guardOptions } = {}) {
  const clock = createClock();
  const sdk = createFakeSdk();
  const log = createLog();
  const exits = [];
  const shutdowns = [];
  const tr = createWebSocketTransport({
    WSClient: sdk.FakeWSClient,
    EventDispatcher: sdk.FakeDispatcher,
    log,
    exit: (code) => exits.push({ code, t: clock.now() }),
    stateFile,
    fs: fsImpl,
    guardOptions,
    ...clock,
  });
  await tr.start(config, { app_id: 'a', app_secret: 's' }, async () => {}, () => false, {
    onShutdown: onShutdown || (async (arg) => { shutdowns.push(arg); }),
  });
  return { clock, sdk, log, tr, exits, shutdowns, stateFile, client: () => sdk.clients[0] };
}

/** Advance time, delivering a pong every interval. */
async function runHealthy(env, ms) {
  let remaining = ms;
  while (remaining > 0) {
    const step = Math.min(INTERVAL, remaining);
    await env.clock.advance(step);
    remaining -= step;
    if (step === INTERVAL) await env.client().pong();
  }
}

const halfOpenErrors = (env) => env.log.lines.error.filter((l) => l.includes('half-open detected'));

test('pong updates lastPongAt, count and still reaches the SDK handler', async () => {
  const env = await setup();
  const c = env.client();
  await env.clock.advance(5_000);
  await c.pong();
  const s = env.tr.getConnectionState();
  assert.equal(s.pongCount, 1);
  assert.equal(s.lastPongAt, new Date(env.clock.now()).toISOString());
  assert.equal(s.lastPongAgeSec, 0);
  assert.equal(c.controlFrames, 1, 'original handleControlData must still run');
  // non-pong control frames are passed through but not counted
  await c.handleControlData({ headers: [{ key: 'type', value: 'ping' }] });
  assert.equal(env.tr.getConnectionState().pongCount, 1);
  assert.equal(c.controlFrames, 2);
  env.tr.stop();
});

test('late WARN logged once per episode, re-armed after a pong; no restart below timeout', async () => {
  const env = await setup();
  await env.client().pong();
  await env.clock.advance(INTERVAL + 60_000);
  const late = () => env.log.lines.warn.filter((l) => l.includes('ws pong late'));
  assert.equal(late().length, 1);
  assert.match(late()[0], /^\[lark\] ws pong late: last pong \d+s ago \(interval 120s\)$/);
  await env.clock.advance(60_000);
  assert.equal(late().length, 1, 'still one warning in the same episode');
  await env.client().pong();
  await env.clock.advance(INTERVAL + 60_000);
  assert.equal(late().length, 2, 'new episode warns again');
  assert.equal(env.exits.length, 0);
  env.tr.stop();
});

test('timeout after a pong -> exactly one controlled restart (close, onShutdown, exit 75), one WSClient ever', async () => {
  const env = await setup();
  await env.client().pong();
  await env.clock.advance(TIMEOUT + WATCHDOG_TICK_MS);

  assert.equal(env.exits.length, 1, 'exit requested once');
  assert.equal(env.exits[0].code, RESTART_EXIT_CODE);
  assert.notEqual(RESTART_EXIT_CODE, 0);
  assert.equal(env.shutdowns.length, 1, 'graceful shutdown hook ran');
  assert.deepEqual(env.shutdowns[0], { reason: 'pong-timeout' });
  assert.equal(env.client().closed, 1, 'WSClient closed best-effort');
  assert.equal(env.sdk.clients.length, 1, 'no second WSClient in-process');
  assert.equal(halfOpenErrors(env).length, 1);
  assert.match(halfOpenErrors(env)[0], /^\[lark\] ws half-open detected: no pong for \d+s \(timeout 360s, socket=open\) -> requesting controlled process restart \(restart 1\/3 in 30m window\)$/);
  assert.ok(env.log.lines.error.some((l) => l.includes(`exiting with code ${RESTART_EXIT_CODE}`)));

  const s = env.tr.getConnectionState();
  assert.equal(s.restartPending, true);
  assert.equal(s.connected, false);
  assert.equal(s.restartsInWindow, 1);
  assert.equal(s.lastRestartReason, 'pong-timeout');

  const st = readState(env.stateFile);
  assert.equal(st.restarts.length, 1);
  assert.equal(st.restarts[0].reason, 'pong-timeout');

  // Nothing more happens afterwards: no timers left, no second request.
  assert.equal(env.clock.pending(), 0, 'watchdog/summary/deadline timers all cleared');
  env.tr._tick();
  await env.clock.advance(20 * INTERVAL);
  assert.equal(env.exits.length, 1);
  assert.equal(env.sdk.clients.length, 1);
  env.tr.stop();
});

test('hard deadline: exit still happens if graceful shutdown hangs', async () => {
  const env = await setup({ onShutdown: () => new Promise(() => {}) });
  await env.client().pong();
  await env.clock.advance(TIMEOUT + WATCHDOG_TICK_MS);
  assert.equal(env.exits.length, 0, 'waiting for graceful shutdown');
  const requestedAt = env.clock.now();
  await env.clock.advance(RESTART_DEADLINE_MS - 1);
  assert.equal(env.exits.length, 0);
  await env.clock.advance(1);
  assert.equal(env.exits.length, 1);
  assert.equal(env.exits[0].code, RESTART_EXIT_CODE);
  assert.ok(env.exits[0].t - requestedAt <= RESTART_DEADLINE_MS);
  assert.ok(RESTART_DEADLINE_MS < 5000, 'below PM2 kill_timeout');
  assert.ok(env.log.lines.error.some((l) => l.includes('exceeded 4s deadline')));
  await env.clock.advance(60_000);
  assert.equal(env.exits.length, 1, 'exit exactly once');
});

test('hard deadline: a throwing close() or failing hook still exits once', async () => {
  const env = await setup({ onShutdown: async () => { throw new Error('hook failed'); } });
  env.client().close = () => { throw new Error('close failed'); };
  await env.client().pong();
  await env.clock.advance(TIMEOUT + WATCHDOG_TICK_MS);
  assert.equal(env.exits.length, 1);
  assert.ok(env.log.lines.warn.some((l) => l.includes('WS close error: close failed')));
  assert.ok(env.log.lines.error.some((l) => l.includes('graceful shutdown error: hook failed')));
  await env.clock.advance(RESTART_DEADLINE_MS * 2);
  assert.equal(env.exits.length, 1);
});

test('no pong ever: never restarts (no boot loop), self-check WARN once', async () => {
  const env = await setup();
  await env.clock.advance(2 * INTERVAL + WATCHDOG_TICK_MS);
  const selfCheck = () => env.log.lines.warn.filter((l) => l.includes('pong detection may be broken'));
  assert.equal(selfCheck().length, 1);
  assert.match(selfCheck()[0], /will not restart the process until a pong is seen/);
  await env.clock.advance(100 * INTERVAL);
  assert.equal(env.exits.length, 0);
  assert.equal(env.shutdowns.length, 0);
  assert.equal(halfOpenErrors(env).length, 0);
  assert.equal(selfCheck().length, 1);
  assert.equal(env.log.lines.warn.filter((l) => l.includes('ws pong late')).length, 0);
  assert.equal(fs.existsSync(env.stateFile), false, 'no restart recorded');

  // once a pong is seen, the watchdog is armed
  await env.client().pong();
  assert.ok(env.log.lines.log.some((l) => l.includes('pong detection working')));
  await env.clock.advance(TIMEOUT + WATCHDOG_TICK_MS);
  assert.equal(env.exits.length, 1);
});

test('rate limit: N restarts in window -> suppressed with one ERROR, monitoring continues, allowed after window', async () => {
  const stateFile = tmpStateFile();
  const clock0 = 1_000_000_000_000;
  // Pre-seed N restarts recorded by previous processes, 10..8 minutes ago.
  const seeded = Array.from({ length: RESTART_MAX_IN_WINDOW }, (_, i) => ({ at: clock0 - (10 - i) * 60_000, reason: 'pong-timeout' }));
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, restarts: seeded }));

  const env = await setup({ stateFile });
  assert.ok(env.log.lines.log.some((l) => /previous watchdog restart at .* \(reason=pong-timeout\); 3\/3 restarts in last 30m/.test(l)));
  assert.equal(env.tr.getConnectionState().restartsInWindow, 3);

  await env.client().pong();
  await env.clock.advance(TIMEOUT + WATCHDOG_TICK_MS);
  assert.equal(env.exits.length, 0, 'restart suppressed');
  assert.equal(halfOpenErrors(env).length, 1);
  assert.match(halfOpenErrors(env)[0], /process restart SUPPRESSED \(rate-limited: 3 restarts in last 30m \(limit 3\); state file .*\); monitoring only, next check at /);
  const s = env.tr.getConnectionState();
  assert.equal(s.restartSuppressed, true);
  assert.equal(s.restartSuppressedReason, 'rate-limited');
  assert.equal(s.restartPending, false);

  // Oldest seeded entry ages out 20 min after start (it was 10 min old);
  // until then no further ERROR and no exit.
  const oldestExpiry = seeded[0].at + RESTART_WINDOW_MS;
  await env.clock.advance(oldestExpiry - env.clock.now() - WATCHDOG_TICK_MS);
  assert.equal(env.exits.length, 0);
  assert.equal(halfOpenErrors(env).length, 1, 'suppression logged once');
  assert.equal(readState(stateFile).restarts.length, 3, 'suppressed attempts are not recorded');

  await env.clock.advance(2 * WATCHDOG_TICK_MS);
  assert.equal(env.exits.length, 1, 'allowed again once the window clears');
  const st = readState(stateFile);
  assert.equal(st.restarts.length, 3, 'expired entry pruned, new one added');
  assert.equal(st.restarts.at(-1).at >= oldestExpiry, true);
});

test('rate limit: a pong while suppressed ends the episode (next episode logs again)', async () => {
  const stateFile = tmpStateFile();
  const t0 = 1_000_000_000_000;
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, restarts: [t0 - 1000, t0 - 2000, t0 - 3000].map((at) => ({ at, reason: 'x' })) }));
  const env = await setup({ stateFile });
  await env.client().pong();
  await env.clock.advance(TIMEOUT + WATCHDOG_TICK_MS);
  assert.equal(env.tr.getConnectionState().restartSuppressed, true);
  await env.client().pong();
  assert.equal(env.tr.getConnectionState().restartSuppressed, false);
  assert.ok(env.log.lines.log.some((l) => l.includes('recovered while process restart was suppressed')));
  await env.clock.advance(TIMEOUT + WATCHDOG_TICK_MS);
  assert.equal(halfOpenErrors(env).length, 2);
  assert.equal(env.exits.length, 0);
});

test('state file corrupt -> fail-safe: no restart, ERROR once, self-heals to a full window', async () => {
  for (const garbage of ['{not json', '[]', '{"restarts":"nope"}', '{"restarts":[{"at":"x"}]}', '']) {
    const stateFile = tmpStateFile();
    fs.writeFileSync(stateFile, garbage);
    const env = await setup({ stateFile });
    assert.ok(env.log.lines.error.some((l) => l.includes('restart state file') && l.includes('refused')), `startup ERROR for ${JSON.stringify(garbage)}`);
    assert.equal(env.tr.getConnectionState().restartsInWindow, null);
    await env.client().pong();
    await env.clock.advance(TIMEOUT + WATCHDOG_TICK_MS);
    assert.equal(env.exits.length, 0, `corrupt ${JSON.stringify(garbage)} must not allow a restart`);
    assert.equal(halfOpenErrors(env).length, 1);
    assert.match(halfOpenErrors(env)[0], /SUPPRESSED \(corrupt: state file (unparseable JSON|unexpected shape); reset to a full window/);
    const healed = readState(stateFile);
    assert.equal(healed.restarts.length, RESTART_MAX_IN_WINDOW);
    assert.ok(healed.restarts.every((r) => r.reason === CORRUPT_REASON));
    // stays refused for a full window, then allowed
    await env.clock.advance(RESTART_WINDOW_MS - 2 * WATCHDOG_TICK_MS);
    assert.equal(env.exits.length, 0);
    assert.equal(halfOpenErrors(env).length, 1, 'logged once');
    await env.clock.advance(3 * WATCHDOG_TICK_MS);
    assert.equal(env.exits.length, 1);
  }
});

test('state file unreadable (EACCES/EISDIR) -> fail-safe: no restart', async () => {
  const stateFile = tmpStateFile();
  fs.mkdirSync(stateFile); // a directory where the file should be -> EISDIR on read, rename fails too
  const env = await setup({ stateFile });
  await env.client().pong();
  await env.clock.advance(TIMEOUT + WATCHDOG_TICK_MS);
  assert.equal(env.exits.length, 0);
  assert.match(halfOpenErrors(env)[0], /SUPPRESSED \(corrupt: state file unreadable \(EISDIR\); reset failed/);
  await env.clock.advance(RESTART_WINDOW_MS);
  assert.equal(env.exits.length, 0, 'still refused while it stays unreadable');
  assert.equal(halfOpenErrors(env).length, 1);
});

test('state file missing -> restart allowed and file created', async () => {
  const stateFile = tmpStateFile();
  assert.equal(fs.existsSync(stateFile), false);
  const env = await setup({ stateFile });
  assert.equal(env.tr.getConnectionState().restartsInWindow, 0);
  await env.client().pong();
  await env.clock.advance(TIMEOUT + WATCHDOG_TICK_MS);
  assert.equal(env.exits.length, 1);
  assert.equal(readState(stateFile).restarts.length, 1);
});

test('state dir unwritable -> restart refused (an unrecorded restart would escape the limit)', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-ws-test-'));
  const notADir = path.join(base, 'file');
  fs.writeFileSync(notADir, 'x');
  const stateFile = path.join(notADir, 'ws-restart-state.json'); // parent is a file -> ENOTDIR, even as root
  const env = await setup({ stateFile });
  await env.client().pong();
  await env.clock.advance(TIMEOUT + WATCHDOG_TICK_MS);
  assert.equal(env.exits.length, 0);
  assert.equal(halfOpenErrors(env).length, 1);
  // The lock file cannot even be created -> fail-closed as lock-unavailable.
  assert.ok(env.log.lines.error.some((l) => /restart lock present at startup -> watchdog restarts BLOCKED; lock .* state=unknown-owner pid=unknown age=\?s error=ENOTDIR/.test(l)));
  assert.match(halfOpenErrors(env)[0], /process restart DEFERRED \(lock-unavailable: cannot lock restart state: ENOTDIR \(unknown-owner, pid unknown, age \?s\)\); blocked for \d+m; lock .* state=unknown-owner .*error=ENOTDIR/);
  assert.doesNotMatch(halfOpenErrors(env)[0], /corrupt/);
  assert.equal(env.tr.getConnectionState().restartSuppressed, true);
  await env.clock.advance(3 * RESTART_WINDOW_MS);
  assert.equal(env.exits.length, 0);
  assert.equal(halfOpenErrors(env).length, 1, 'logged once per episode');
});

test('state dir unwritable (write fails after a clean read) -> restart refused', async () => {
  const stateFile = tmpStateFile();
  // Lock works; only the ledger temp-file write fails.
  const failingFs = { ...fs, openSync: (p, ...a) => { if (p.endsWith('.tmp')) { const e = new Error('EROFS: read-only file system'); e.code = 'EROFS'; throw e; } return fs.openSync(p, ...a); } };
  const env = await setup({ stateFile, fsImpl: failingFs });
  await env.client().pong();
  await env.clock.advance(TIMEOUT + WATCHDOG_TICK_MS);
  assert.equal(env.exits.length, 0);
  assert.match(halfOpenErrors(env)[0], /SUPPRESSED \(write-failed: cannot persist restart record \(EROFS\)/);
  assert.equal(fs.existsSync(`${stateFile}.lock`), false, 'lock released after write failure');
});

const M = 60_000;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const blockedLines = (env) => env.log.lines.error.filter((l) => /DEFERRED|BLOCKED/.test(l));

test('blocked lock found at startup: immediate ERROR with path/owner/safe hint, escalating cadence, holder change, one release line', async () => {
  const stateFile = tmpStateFile();
  const lock = `${stateFile}.lock`;
  const dead = deadPid();
  const lockBody = JSON.stringify({ pid: dead, acquiredAt: '2026-01-01T00:00:00.000Z', token: 'SECRET-TOKEN-VALUE' });
  fs.writeFileSync(lock, lockBody);
  // lockTimeoutMs 0: refuse at once instead of waiting 2s real time per retry
  const env = await setup({ stateFile, guardOptions: { lockTimeoutMs: 0 } });
  const t0 = env.clock.now();

  // (a) first ERROR immediately at startup (a restarted process re-detects it)
  assert.equal(blockedLines(env).length, 1);
  const first = blockedLines(env)[0];
  assert.ok(first.startsWith('[lark] ws restart lock present at startup -> watchdog restarts BLOCKED; '), first);
  assert.ok(first.includes(`lock ${lock} state=held-by-dead-pid pid=${dead} age=`), first);
  assert.ok(first.includes(`recovery: verify the holder first: \`ps -p ${dead}\` shows that pid is not a running zylos-lark process and \`pm2 ls\` shows no second zylos-lark instance; only then remove ${lock} manually to re-enable watchdog restarts`), first);

  const h = env.tr.getConnectionState();
  assert.equal(h.lockPath, lock);
  assert.equal(h.lockState, 'held-by-dead-pid');
  assert.equal(h.lockOwnerPid, dead);
  assert.equal(typeof h.lockAgeSec, 'number');
  assert.equal(h.lockError, null);
  assert.equal(h.restartBlockedSince, new Date(t0).toISOString());
  assert.equal(h.restartSuppressed, true, 'blocked before any attempt');
  assert.equal(h.restartSuppressedReason, 'lock-unavailable');
  assert.ok(h.recoveryHint.includes(`ps -p ${dead}`) && h.recoveryHint.includes(`remove ${lock} manually`));

  // (b) 5m repeat, then half-open while blocked -> one DEFERRED line, no exit
  await env.clock.advance(5 * M - 1);
  assert.equal(blockedLines(env).length, 1);
  await env.clock.advance(1);
  assert.equal(blockedLines(env).length, 2);
  assert.match(blockedLines(env)[1], /^\[lark\] ws watchdog restarts STILL BLOCKED for 5m; lock .* state=held-by-dead-pid .*; recovery: verify the holder first/);
  await env.client().pong();
  await env.clock.advance(TIMEOUT + WATCHDOG_TICK_MS);
  assert.equal(blockedLines(env).length, 3);
  assert.match(blockedLines(env)[2], /ws half-open detected: .* -> process restart DEFERRED \(lock-unavailable: cannot lock restart state: lock busy for 0ms \(held-by-dead-pid, pid \d+, age \d+s\)\); blocked for 11m; lock /);
  assert.equal(env.tr.getConnectionState().restartSuppressedReason, 'lock-unavailable');
  assert.doesNotMatch(blockedLines(env)[2], /corrupt/);

  // (c) cadence from the episode start: 30m, 60m, then hourly
  const at = async (ms) => env.clock.advance(t0 + ms - env.clock.now());
  await at(30 * M - 1); assert.equal(blockedLines(env).length, 3);
  await at(30 * M);      assert.equal(blockedLines(env).length, 4);
  assert.match(blockedLines(env)[3], /STILL BLOCKED for 30m/);
  await at(60 * M - 1);  assert.equal(blockedLines(env).length, 4);
  await at(60 * M);      assert.equal(blockedLines(env).length, 5);
  await at(120 * M - 1); assert.equal(blockedLines(env).length, 5);
  await at(120 * M);     assert.equal(blockedLines(env).length, 6);
  await at(180 * M);     assert.equal(blockedLines(env).length, 7);
  assert.match(blockedLines(env)[6], /STILL BLOCKED for 180m/);
  assert.equal(env.exits.length, 0, 'never restarts while blocked');
  assert.equal(fs.readFileSync(lock, 'utf8'), lockBody, 'lock never touched');

  // (d) holder changes -> diagnosis refreshed at the next tick, cadence restarts
  const live = process.pid;
  fs.writeFileSync(lock, JSON.stringify({ pid: live, token: 'OTHER-SECRET' }));
  await env.clock.advance(WATCHDOG_TICK_MS);
  assert.equal(blockedLines(env).length, 8);
  assert.match(blockedLines(env)[7], new RegExp(`^\\[lark\\] ws restart lock holder changed -> watchdog restarts still BLOCKED \\(for 180m\\); lock ${esc(lock)} state=held-by-live-pid pid=${live} `));
  const changedAt = env.clock.now();
  await env.clock.advance(5 * M - WATCHDOG_TICK_MS); assert.equal(blockedLines(env).length, 8);
  await env.clock.advance(changedAt + 5 * M - env.clock.now()); assert.equal(blockedLines(env).length, 9, 'cadence restarted at the change');
  assert.equal(env.tr.getConnectionState().lockState, 'held-by-live-pid', 'health follows the current observation');
  assert.equal(env.tr.getConnectionState().restartBlockedSince, new Date(t0).toISOString(), 'same episode');

  // (e) released -> exactly one release line, blocked-since cleared, restart proceeds
  fs.unlinkSync(lock);
  await env.clock.advance(WATCHDOG_TICK_MS);
  const released = env.log.lines.log.filter((l) => l.includes('restart lock released'));
  assert.equal(released.length, 1);
  assert.match(released[0], new RegExp(`^\\[lark\\] ws restart lock released after 18\\dm \\(lock ${esc(lock)} gone\\); watchdog restarts re-enabled$`));
  const h2 = env.tr.getConnectionState();
  assert.equal(h2.restartBlockedSince, null);
  assert.equal(h2.recoveryHint, null);
  assert.equal(h2.lockState, 'free');
  assert.equal(h2.restartSuppressed, false);
  await env.clock.advance(2 * WATCHDOG_TICK_MS);
  assert.equal(env.exits.length, 1, 'half-open still present -> restart now allowed');
  assert.equal(env.log.lines.log.filter((l) => l.includes('restart lock released')).length, 1, 'still exactly one release line');

  // no token values anywhere
  const all = env.log.all().join('\n') + JSON.stringify(env.tr.getConnectionState());
  assert.ok(!all.includes('SECRET'), 'lock token never logged or exposed');
});

test('blocked lock appearing at half-open: first line is DEFERRED with diagnosis; new process re-detects it at once', async () => {
  const stateFile = tmpStateFile();
  const lock = `${stateFile}.lock`;
  const env = await setup({ stateFile, guardOptions: { lockTimeoutMs: 0 } });
  assert.equal(blockedLines(env).length, 0);
  assert.equal(env.tr.getConnectionState().lockState, 'free');
  fs.writeFileSync(lock, ''); // e.g. crash between create and write
  await env.client().pong();
  await env.clock.advance(TIMEOUT + WATCHDOG_TICK_MS);
  assert.equal(blockedLines(env).length, 1);
  assert.match(blockedLines(env)[0], new RegExp(`-> process restart DEFERRED \\(lock-unavailable: .*\\(unknown-owner, pid unknown, age \\d+s\\)\\); lock ${esc(lock)} state=unknown-owner pid=unknown age=\\d+s error=empty; monitoring continues, retrying every 60s; recovery: verify the holder first: the lock names no valid owner pid and \`pm2 ls\` shows no second zylos-lark instance; only then remove ${esc(lock)} manually`));
  const h = env.tr.getConnectionState();
  assert.equal(h.lockState, 'unknown-owner');
  assert.equal(h.lockError, 'empty');
  env.tr.stop();

  // "process restart": in-memory counters are gone, the lock is not
  const env2 = await setup({ stateFile, guardOptions: { lockTimeoutMs: 0 } });
  assert.equal(blockedLines(env2).length, 1, 'fresh episode, first ERROR immediately');
  assert.match(blockedLines(env2)[0], /present at startup -> watchdog restarts BLOCKED; .*state=unknown-owner .*error=empty/);
  assert.equal(env2.tr.getConnectionState().restartBlockedSince, new Date(env2.clock.now()).toISOString());
  env2.tr.stop();
});

test('inspectLock distinguishes absent, released-during-read and permission errors', () => {
  const stateFile = tmpStateFile();
  const lock = `${stateFile}.lock`;
  const mkFs = (over) => ({ ...fs, ...over });
  const err = (code) => { const e = new Error(code); e.code = code; return e; };
  const g = (over) => createRestartGuard({ file: stateFile, fs: mkFs(over) }).inspectLock();
  assert.deepEqual(g({}), { lockPath: lock, lockState: 'free', lockOwnerPid: null, lockAgeSec: null, lockError: null });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 't' }));
  assert.deepEqual(g({ readFileSync: (p, ...a) => { if (p === lock) throw err('ENOENT'); return fs.readFileSync(p, ...a); } }),
    { lockPath: lock, lockState: 'free', lockOwnerPid: null, lockAgeSec: null, lockError: 'ENOENT-during-read' });
  const acc = g({ readFileSync: (p, ...a) => { if (p === lock) throw err('EACCES'); return fs.readFileSync(p, ...a); } });
  assert.equal(acc.lockState, 'unknown-owner');
  assert.equal(acc.lockError, 'EACCES');
  const perm = g({ statSync: (p, ...a) => { if (p === lock) throw err('EPERM'); return fs.statSync(p, ...a); } });
  assert.deepEqual(perm, { lockPath: lock, lockState: 'unknown-owner', lockOwnerPid: null, lockAgeSec: null, lockError: 'EPERM' });
  const ok = g({});
  assert.equal(ok.lockState, 'held-by-live-pid');
  assert.equal(ok.lockOwnerPid, process.pid);
  assert.ok(!JSON.stringify(ok).includes('"t"'), 'token not exposed');
});

test('atomic write: same-dir temp file, fsync, rename; no temp left behind', async () => {
  const stateFile = tmpStateFile();
  const calls = [];
  const spyFs = {
    ...fs,
    openSync: (p, ...a) => { if (!p.endsWith('.lock')) calls.push(['open', p]); return fs.openSync(p, ...a); },
    fsyncSync: (fd) => { if (calls.length) calls.push(['fsync']); return fs.fsyncSync(fd); },
    renameSync: (a, b) => { calls.push(['rename', a, b]); return fs.renameSync(a, b); },
  };
  let t = 5_000_000;
  const guard = createRestartGuard({ file: stateFile, fs: spyFs, now: () => t });
  assert.deepEqual(await guard.tryAcquire('pong-timeout'), { allowed: true, restartsInWindow: 1 });
  const [open, fsync, rename] = calls;
  assert.equal(open[0], 'open');
  assert.equal(path.dirname(open[1]), path.dirname(stateFile), 'temp file in the same directory');
  assert.notEqual(open[1], stateFile);
  assert.deepEqual(fsync, ['fsync']);
  assert.deepEqual(rename, ['rename', open[1], stateFile]);
  assert.deepEqual(fs.readdirSync(path.dirname(stateFile)), ['ws-restart-state.json']);
  assert.equal((fs.statSync(stateFile).mode & 0o777), 0o600);

  // failed rename cleans up its temp file and leaves the old file intact
  const before = fs.readFileSync(stateFile, 'utf8');
  const badFs = { ...spyFs, renameSync: () => { const e = new Error('EXDEV'); e.code = 'EXDEV'; throw e; } };
  t += 1000;
  const g2 = createRestartGuard({ file: stateFile, fs: badFs, now: () => t });
  const v = await g2.tryAcquire('pong-timeout');
  assert.equal(v.allowed, false);
  assert.equal(v.cause, 'write-failed');
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(stateFile)), ['ws-restart-state.json']);
});

test('restart guard: window pruning and future timestamps counted conservatively', async () => {
  const stateFile = tmpStateFile();
  let t = 10 * RESTART_WINDOW_MS;
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, restarts: [
    { at: t - RESTART_WINDOW_MS - 1, reason: 'old' }, // expired
    { at: t + 60_000, reason: 'future' }, // clock stepped back: counts
    { at: t - 1000, reason: 'recent' },
  ] }));
  const guard = createRestartGuard({ file: stateFile, now: () => t });
  assert.equal((await guard.tryAcquire('pong-timeout')).allowed, true); // 2 in window -> 3rd allowed
  assert.deepEqual(readState(stateFile).restarts.map((r) => r.reason), ['recent', 'future', 'pong-timeout']);
  const v = await guard.tryAcquire('pong-timeout');
  assert.equal(v.allowed, false);
  assert.equal(v.cause, 'rate-limited');
  assert.equal(v.retryAt, t - 1000 + RESTART_WINDOW_MS);
});

test('configured ws_pong_timeout_sec overrides default; 0 disables restarts but keeps monitoring', async () => {
  const env = await setup({ config: { ws_pong_timeout_sec: 200 } });
  await env.client().pong();
  await env.clock.advance(200_000 + WATCHDOG_TICK_MS);
  assert.equal(env.exits.length, 1);
  assert.ok(halfOpenErrors(env)[0].includes('(timeout 200s,'));

  const off = await setup({ config: { ws_pong_timeout_sec: 0 } });
  assert.ok(off.log.lines.log.some((l) => l.includes('pong timeout: disabled (monitoring only)')));
  await off.client().pong();
  await off.clock.advance(20 * INTERVAL);
  assert.equal(off.exits.length, 0);
  assert.equal(off.log.lines.warn.filter((l) => l.includes('ws pong late')).length, 1, 'monitoring still active');
  off.tr.stop();

  const low = await setup({ config: { ws_pong_timeout_sec: 10 } });
  assert.ok(low.log.lines.warn.some((l) => l.includes('invalid ws_pong_timeout_sec=10')));
  await low.client().pong();
  await low.clock.advance(60_000);
  assert.equal(low.exits.length, 0, 'value < 30 rejected, default 3 x interval used');
  low.tr.stop();
});

test('parsePongTimeout validation', () => {
  const log = createLog();
  assert.deepEqual(parsePongTimeout(undefined, log), { mode: 'auto' });
  assert.deepEqual(parsePongTimeout(0, log), { mode: 'disabled' });
  assert.deepEqual(parsePongTimeout(300, log), { mode: 'fixed', ms: 300_000 });
  assert.deepEqual(parsePongTimeout(5, log), { mode: 'auto' });
  assert.deepEqual(parsePongTimeout('abc', log), { mode: 'auto' });
  assert.equal(log.lines.warn.length, 2);
});

test('missing handleControlData logs a detection-unavailable WARN and never restarts', async () => {
  const clock = createClock();
  const sdk = createFakeSdk();
  sdk.FakeWSClient.prototype.handleControlData = undefined;
  const log = createLog();
  const exits = [];
  const tr = createWebSocketTransport({ WSClient: sdk.FakeWSClient, EventDispatcher: sdk.FakeDispatcher, log, exit: (c) => exits.push(c), stateFile: tmpStateFile(), ...clock });
  await tr.start({}, { app_id: 'a', app_secret: 's' }, async () => {}, () => false);
  assert.ok(log.lines.warn.some((l) => l.includes('pong detection unavailable')));
  await clock.advance(50 * INTERVAL);
  assert.equal(exits.length, 0);
  tr.stop();
});

test('start() twice is refused (one WSClient per process)', async () => {
  const env = await setup();
  await assert.rejects(env.tr.start({}, { app_id: 'a', app_secret: 's' }, async () => {}, () => false), /already started/);
  assert.equal(env.sdk.clients.length, 1);
  env.tr.stop();
});

test('30m summary line', async () => {
  const env = await setup();
  await runHealthy(env, SUMMARY_INTERVAL_MS - 60_000);
  await env.clock.advance(60_000);
  const line = env.log.lines.log.find((l) => l.includes('ws heartbeat'));
  assert.match(line, /^\[lark\] ws heartbeat ok: last pong \d+s ago, 14 pongs in 30m$/);
  env.tr.stop();
});

test('health fields present and no ws url is ever logged', async () => {
  const env = await setup();
  const s0 = env.tr.getConnectionState();
  assert.deepEqual(Object.keys(s0).sort(), [
    'connected', 'connectedSince', 'lastPongAgeSec', 'lastPongAt', 'lastRestartAt', 'lastRestartReason',
    'lockAgeSec', 'lockError', 'lockOwnerPid', 'lockPath', 'lockState',
    'pongCount', 'recoveryHint', 'restartBlockedSince', 'restartPending', 'restartSuppressed', 'restartSuppressedReason', 'restartsInWindow',
  ].sort());
  assert.equal(s0.lockPath, `${env.stateFile}.lock`);
  assert.equal(s0.lockState, 'free');
  assert.equal(s0.lockAgeSec, null);
  assert.equal(s0.lockOwnerPid, null);
  assert.equal(s0.lockError, null);
  assert.equal(s0.restartBlockedSince, null);
  assert.equal(s0.recoveryHint, null);
  assert.equal(s0.connected, true);
  assert.equal(s0.lastPongAt, null);
  assert.equal(s0.lastPongAgeSec, null);
  assert.equal(s0.restartsInWindow, 0);
  assert.equal(s0.lastRestartAt, null);
  assert.equal(s0.lastRestartReason, null);
  assert.equal(s0.restartSuppressed, false);
  assert.equal(s0.restartPending, false);
  await env.client().pong();
  await env.clock.advance(42_000);
  assert.equal(env.tr.getConnectionState().lastPongAgeSec, 42);
  await env.clock.advance(TIMEOUT);
  assert.ok(!env.log.all().some((l) => /wss?:\/\/|access_key|ticket/.test(l)));
});

test('stop() clears timers, closes the client, and is idempotent', async () => {
  const env = await setup();
  env.tr.stop();
  env.tr.stop();
  assert.equal(env.client().closed, 1);
  assert.equal(env.clock.pending(), 0);
  assert.equal(env.tr.getConnectionState().connected, false);
  await env.clock.advance(100 * INTERVAL);
  assert.equal(env.exits.length, 0);
});
