/**
 * In-process regression with the REAL @larksuiteoapi/node-sdk 1.59.0 WSClient
 * (no external network: config pull + event socket go to a loopback fake
 * Lark server, see test/fixtures/fake-lark-server.mjs; real timers).
 *
 * 1. Documents the SDK limitation behind the design (review finding):
 *    close() cannot cancel a reConnect() closure already awaiting
 *    pullConnectConfig() — after close() it still opens a new socket — and
 *    the DataCache setInterval created by every WSClient survives close().
 *    So no in-process "retire and replace the client" scheme can be complete.
 * 2. Proves the chosen path: one WSClient per process; on half-open the
 *    transport requests a process exit (code 75) and, after that request,
 *    nothing in-process pulls config, opens a socket, pings or builds a new
 *    WSClient. The DataCache interval is still alive at that point, i.e. the
 *    process exit (not in-process cleanup) is what reclaims it. The actual
 *    exit + PM2-style restart is covered by test/ws-restart-process.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';

import { createWebSocketTransport, RESTART_EXIT_CODE } from '../src/lib/transport/websocket.js';
import { startFakeLark, makeHttpInstance } from './fixtures/fake-lark-server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred, timeoutMs = 10_000, what = 'condition') {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** Real WSClient pointed at the fake server; records instances + DataCache interval handles. */
function makeRealClientClass(fake) {
  const instances = [];
  class RealWSClient extends lark.WSClient {
    constructor(params) {
      const orig = globalThis.setInterval;
      let handle = null;
      globalThis.setInterval = (...a) => (handle = orig(...a));
      try {
        super({ ...params, domain: fake.domain, httpInstance: makeHttpInstance(), loggerLevel: lark.LoggerLevel.error });
      } finally {
        globalThis.setInterval = orig;
      }
      this.__dataCacheInterval = handle;
      instances.push(this);
    }
  }
  return { RealWSClient, instances };
}

const alive = (h) => !!h && h.hasRef() && !h._destroyed;

test('SDK 1.59.0 limitation: close() does not cancel an in-flight reConnect, nor the DataCache interval', { timeout: 20_000 }, async (t) => {
  const fake = await startFakeLark({ pingIntervalSec: 1 });
  const { RealWSClient, instances } = makeRealClientClass(fake);
  const client = new RealWSClient({ appId: 'cli_test', appSecret: 'test-secret', autoReconnect: true });
  t.after(async () => {
    try { client.close({ force: true }); } catch { /* ignore */ }
    for (const c of instances) clearInterval(c.__dataCacheInterval);
    await fake.close();
  });

  await client.start({ eventDispatcher: new lark.EventDispatcher({}) });
  await waitUntil(() => fake.count('connect') === 1, 5000, 'first connect');

  // Hold the next config pull in flight, then make the SDK reconnect.
  fake.setConfigDelay(800);
  fake.dropSockets();
  await waitUntil(() => fake.count('config') === 2, 5000, 'reConnect config pull in flight');

  client.close({ force: true }); // what the old retireClient() relied on
  const closedAt = Date.now();
  await sleep(1500);

  assert.ok(fake.count('connect', closedAt) >= 1,
    'the in-flight reConnect closure opened a NEW socket after close()');
  assert.equal(alive(client.__dataCacheInterval), true,
    'DataCache setInterval survives close(); only process exit reclaims it');
});

test('real SDK: half-open -> exit requested once; afterwards no config pull / socket / ping / WSClient in-process', { timeout: 30_000 }, async (t) => {
  const fake = await startFakeLark({ pingIntervalSec: 1 }); // auto timeout = 3 x 1s
  const { RealWSClient, instances } = makeRealClientClass(fake);
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lark-ws-real-')), 'ws-restart-state.json');
  const exits = [];
  const shutdowns = [];
  const logs = [];
  const tr = createWebSocketTransport({
    WSClient: RealWSClient,
    exit: (code) => exits.push({ code, t: Date.now() }),
    stateFile,
    watchdogTickMs: 100,
    log: { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
  });
  t.after(async () => {
    tr.stop();
    for (const c of instances) { try { c.close({ force: true }); } catch { /* ignore */ } clearInterval(c.__dataCacheInterval); }
    await fake.close();
  });

  await tr.start({ domain: 'lark' }, { app_id: 'cli_test', app_secret: 'test-secret' }, async () => {}, () => false, {
    onShutdown: async (arg) => { shutdowns.push(arg); },
  });
  await waitUntil(() => tr.getConnectionState().pongCount >= 2, 8000, 'real pongs observed via handleControlData wrapper');
  assert.equal(fake.count('config'), 1);
  assert.equal(fake.count('connect'), 1);

  fake.setRespond(false); // half-open: socket stays OPEN, pings unanswered
  await waitUntil(() => exits.length === 1, 8000, 'restart request');
  const requestedAt = exits[0].t;
  assert.equal(exits[0].code, RESTART_EXIT_CODE);
  assert.deepEqual(shutdowns, [{ reason: 'pong-timeout' }]);
  assert.ok(logs.some((l) => /ws half-open detected: no pong for \d+s \(timeout 3s, socket=open\) -> requesting controlled process restart/.test(l)));

  // The process would now be gone. Stay alive past several ping and SDK
  // reconnect intervals (1s each) and prove nothing else happens in-process.
  await sleep(3000);
  assert.equal(instances.length, 1, 'exactly one WSClient ever constructed');
  assert.equal(fake.count('config'), 1, 'no config pull after the restart request');
  assert.equal(fake.count('connect'), 1, 'no new socket after the restart request');
  assert.equal(fake.count('ping', requestedAt + 50), 0, 'no pings after close');
  assert.equal(fake.count('close'), 1, 'the one socket was closed');
  assert.equal(exits.length, 1, 'exit requested exactly once');
  assert.equal(instances[0].wsConfig.getWSInstance(), null);
  assert.equal(alive(instances[0].__dataCacheInterval), true,
    'DataCache interval still alive after close(): reclaimed by process exit, not in-process cleanup');
  assert.ok(!logs.some((l) => /wss?:\/\//.test(l)), 'ws url never logged');

  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(st.restarts.length, 1);
});
