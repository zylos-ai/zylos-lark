import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWebSocketTransport,
  parsePongTimeout,
  WATCHDOG_TICK_MS,
  SUMMARY_INTERVAL_MS,
  DEFAULT_PING_INTERVAL_MS,
} from '../src/lib/transport/websocket.js';

const INTERVAL = DEFAULT_PING_INTERVAL_MS; // 120s

// ---------- fake clock ----------
function createClock(start = 1_000_000) {
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
function createFakeSdk({ startFailures = 0, openSocket = () => true } = {}) {
  const clients = [];
  let failuresLeft = startFailures;
  class FakeWSClient {
    constructor(params) {
      this.params = params;
      this.closed = false;
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
    async start() {
      if (failuresLeft > 0) { failuresLeft--; throw new Error('boom'); }
      if (openSocket(clients.length)) this.wsConfig.setWSInstance({ readyState: 1 });
    }
    close() { this.closed = true; this.wsInstance = null; }
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

async function setup(opts = {}, config = { domain: 'lark' }) {
  const clock = createClock();
  const sdk = createFakeSdk(opts);
  const log = createLog();
  const tr = createWebSocketTransport({
    WSClient: sdk.FakeWSClient,
    EventDispatcher: sdk.FakeDispatcher,
    log,
    ...clock,
  });
  await tr.start(config, { app_id: 'a', app_secret: 's' }, async () => {}, () => false);
  return { clock, sdk, log, tr };
}

/** Advance time, delivering a pong on the current client every interval. */
async function runHealthy(env, ms) {
  let remaining = ms;
  while (remaining > 0) {
    const step = Math.min(INTERVAL, remaining);
    await env.clock.advance(step);
    remaining -= step;
    if (step === INTERVAL) await env.tr._getClient().pong();
  }
}

test('pong updates lastPongAt, count and still reaches the SDK handler', async () => {
  const env = await setup();
  const c = env.sdk.clients[0];
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

test('late WARN logged once per episode, re-armed after a pong', async () => {
  const env = await setup();
  await env.sdk.clients[0].pong();
  await env.clock.advance(INTERVAL + 60_000); // late but below 3x timeout
  const late = () => env.log.lines.warn.filter((l) => l.includes('ws pong late'));
  assert.equal(late().length, 1);
  assert.match(late()[0], /^\[lark\] ws pong late: last pong \d+s ago \(interval 120s\)$/);
  await env.clock.advance(60_000);
  assert.equal(late().length, 1, 'still one warning in the same episode');
  await env.sdk.clients[0].pong();
  await env.clock.advance(INTERVAL + 60_000);
  assert.equal(late().length, 2, 'new episode warns again');
  assert.equal(env.sdk.clients.length, 1, 'no reconnect below timeout');
  env.tr.stop();
});

test('pong timeout triggers exactly one reconnect and closes the old client', async () => {
  const env = await setup();
  const old = env.sdk.clients[0];
  await old.pong();
  await env.clock.advance(3 * INTERVAL + WATCHDOG_TICK_MS);
  assert.equal(env.sdk.clients.length, 2);
  assert.equal(old.closed, true);
  const err = env.log.lines.error.find((l) => l.includes('half-open'));
  assert.match(err, /^\[lark\] ws half-open detected: no pong for \d+s \(timeout 360s\) -> reconnecting$/);
  assert.ok(env.log.lines.log.some((l) => /^\[lark\] ws reconnected in \d+\.\ds \(previous connection up .+, reason=pong-timeout/.test(l)));
  const s = env.tr.getConnectionState();
  assert.equal(s.reconnects, 1);
  assert.equal(s.lastReconnectReason, 'pong-timeout');
  assert.equal(s.connected, true);

  // old client's pongs no longer affect state; new client's do
  const before = s.pongCount;
  await old.pong();
  assert.equal(env.tr.getConnectionState().pongCount, before);
  assert.equal(typeof old.reConnect, 'function');
  assert.equal(await old.connect(), false, 'retired client is neutered');

  // keep new client healthy: no further reconnects
  await runHealthy(env, 10 * INTERVAL);
  assert.equal(env.sdk.clients.length, 2);
  env.tr.stop();
});

test('single-flight: repeated ticks and calls during a reconnect do not start another', async () => {
  // second client never opens a socket -> reconnect stays in its wait loop
  const env = await setup({ openSocket: (n) => n !== 2 });
  await env.sdk.clients[0].pong();
  await env.clock.advance(3 * INTERVAL + WATCHDOG_TICK_MS);
  assert.equal(env.sdk.clients.length, 2);
  assert.equal(env.tr.getConnectionState().reconnecting, true);
  env.tr._tick();
  env.tr._tick();
  assert.equal(await env.tr._reconnect('manual'), false);
  await env.clock.advance(5_000);
  assert.equal(env.sdk.clients.length, 2, 'no concurrent reconnect');
  assert.equal(env.log.lines.error.filter((l) => l.includes('half-open')).length, 1);
  env.tr.stop();
});

test('exponential backoff on start() failure, capped, then success', async () => {
  const env = await setup();
  await env.sdk.clients[0].pong();
  // make the next 5 start() calls fail
  let fails = 5;
  const origStart = env.sdk.FakeWSClient.prototype.start;
  env.sdk.FakeWSClient.prototype.start = async function () {
    if (fails > 0) { fails--; throw new Error('boom'); }
    return origStart.call(this);
  };
  await env.clock.advance(3 * INTERVAL + WATCHDOG_TICK_MS);
  await env.clock.advance(5_000 + 10_000 + 20_000 + 40_000 + 60_000 + 1_000);
  const failures = env.log.lines.error.filter((l) => l.includes('reconnect failed'));
  assert.equal(failures.length, 5);
  const delays = failures.map((l) => Number(l.match(/next retry in (\d+)s/)[1]));
  assert.deepEqual(delays, [5, 10, 20, 40, 60]);
  assert.match(failures[0], /^\[lark\] ws reconnect failed \(attempt 1, reason=pong-timeout\): boom; next retry in 5s$/);
  assert.equal(env.sdk.clients.length, 7);
  assert.equal(env.tr.getConnectionState().reconnects, 1);
  assert.ok(env.log.lines.log.some((l) => l.includes('ws reconnected') && l.includes('attempt 6')));
  env.tr.stop();
});

test('no pong ever: self-check WARN, one capped blind reconnect, no loop', async () => {
  const env = await setup();
  await env.clock.advance(2 * INTERVAL + WATCHDOG_TICK_MS);
  assert.equal(env.log.lines.warn.filter((l) => l.includes('pong detection may be broken')).length, 1);
  await env.clock.advance(INTERVAL + WATCHDOG_TICK_MS); // past 3x
  assert.equal(env.sdk.clients.length, 2, 'one blind reconnect allowed');
  await env.clock.advance(20 * INTERVAL);
  assert.equal(env.sdk.clients.length, 2, 'no further reconnects while detection looks broken');
  assert.equal(env.log.lines.warn.filter((l) => l.includes('reconnect suppressed')).length, 1);
  assert.equal(env.log.lines.warn.filter((l) => l.includes('pong detection may be broken')).length, 1);
  assert.equal(env.log.lines.warn.filter((l) => l.includes('ws pong late')).length, 0);

  // once a pong is seen, the watchdog is fully armed again
  await env.tr._getClient().pong();
  assert.ok(env.log.lines.log.some((l) => l.includes('pong detection working')));
  await env.clock.advance(3 * INTERVAL + WATCHDOG_TICK_MS);
  assert.equal(env.sdk.clients.length, 3);
  env.tr.stop();
});

test('missing handleControlData logs a detection-unavailable WARN', async () => {
  const clock = createClock();
  const sdk = createFakeSdk();
  sdk.FakeWSClient.prototype.handleControlData = undefined;
  const log = createLog();
  const tr = createWebSocketTransport({ WSClient: sdk.FakeWSClient, EventDispatcher: sdk.FakeDispatcher, log, ...clock });
  await tr.start({}, { app_id: 'a', app_secret: 's' }, async () => {}, () => false);
  assert.ok(log.lines.warn.some((l) => l.includes('pong detection unavailable')));
  tr.stop();
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
  for (const k of ['connected', 'connectedSince', 'lastPongAt', 'lastPongAgeSec', 'reconnects', 'lastReconnectReason']) {
    assert.ok(k in s0, `missing ${k}`);
  }
  assert.equal(s0.lastPongAt, null);
  assert.equal(s0.lastPongAgeSec, null);
  assert.equal(s0.reconnects, 0);
  assert.equal(s0.lastReconnectReason, null);
  await env.sdk.clients[0].pong();
  await env.clock.advance(42_000);
  assert.equal(env.tr.getConnectionState().lastPongAgeSec, 42);
  assert.ok(!env.log.all().some((l) => /wss?:\/\/|access_key|ticket/.test(l)));
  env.tr.stop();
});

test('configured ws_pong_timeout_sec overrides default; 0 disables reconnect', async () => {
  const env = await setup({}, { ws_pong_timeout_sec: 200 });
  await env.sdk.clients[0].pong();
  await env.clock.advance(200_000 + WATCHDOG_TICK_MS);
  assert.equal(env.sdk.clients.length, 2);
  assert.ok(env.log.lines.error.some((l) => l.includes('(timeout 200s)')));
  env.tr.stop();

  const off = await setup({}, { ws_pong_timeout_sec: 0 });
  await off.sdk.clients[0].pong();
  await off.clock.advance(20 * INTERVAL);
  assert.equal(off.sdk.clients.length, 1);
  off.tr.stop();
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

test('stop() clears timers and closes the client', async () => {
  const env = await setup();
  env.tr.stop();
  assert.equal(env.sdk.clients[0].closed, true);
  assert.equal(env.clock.pending(), 0);
  assert.equal(env.tr.getConnectionState().connected, false);
});
