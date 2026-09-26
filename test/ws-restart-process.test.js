/**
 * PROCESS-LEVEL regression for the controlled restart (real child processes,
 * REAL @larksuiteoapi/node-sdk WSClient, loopback fake Lark server, no
 * external network). The test itself plays PM2: when a child exits it starts
 * a new one against the same persisted restart-state file.
 *
 * Asserted per child: exit code 75 via the real process.exit path; between
 * half-open detection and exit no new config request, socket or WSClient;
 * exactly one WSClient per process; the SDK DataCache interval is still alive
 * at shutdown (so it is the exit that reclaims it). Across children: new PID
 * takes over and reads the persisted state; the cross-process rate limit
 * suppresses the restart that would exceed RESTART_MAX_IN_WINDOW and that
 * child keeps running.
 *
 * Fake-clock unit coverage lives in test/ws-pong-watchdog.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { RESTART_EXIT_CODE, RESTART_MAX_IN_WINDOW } from '../src/lib/transport/websocket.js';
import { startFakeLark } from './fixtures/fake-lark-server.mjs';

const CHILD = fileURLToPath(new URL('./fixtures/ws-restart-child.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function runChild(env) {
  const child = spawn(process.execPath, [CHILD], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  const raw = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      raw.push(line);
      try { lines.push({ ...JSON.parse(line), rxAt: Date.now() }); } catch { /* SDK console output */ }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => raw.push(`[stderr] ${c}`));
  const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, t: Date.now() })));
  const find = (pred) => lines.find(pred);
  return {
    child,
    lines,
    raw,
    closed,
    find,
    async waitFor(pred, timeoutMs, what) {
      await waitUntil(() => find(pred) || child.exitCode !== null, timeoutMs, what);
      const hit = find(pred);
      if (!hit) throw new Error(`child exited before ${what}:\n${raw.join('\n')}`);
      return hit;
    },
  };
}

const isHalfOpen = (l) => l.ev === 'log' && l.level === 'error' && l.m.includes('half-open detected');

test('process-level: half-open -> exit 75, nothing new before exit, PM2 stand-in restart takes over, rate limit holds across processes', { timeout: 90_000 }, async (t) => {
  const fake = await startFakeLark({ pingIntervalSec: 1 }); // auto timeout 3s
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-ws-proc-'));
  const stateFile = path.join(dir, 'ws-restart-state.json');
  const env = { FAKE_LARK_DOMAIN: fake.domain, WS_STATE_FILE: stateFile, WS_TICK_MS: '100' };
  const children = [];
  t.after(async () => {
    for (const c of children) if (c.child.exitCode === null) c.child.kill('SIGKILL');
    await fake.close();
  });

  // One restart already recorded by an earlier process, so the third child
  // below is the one that hits RESTART_MAX_IN_WINDOW (3).
  assert.equal(RESTART_MAX_IN_WINDOW, 3);
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, restarts: [{ at: Date.now() - 60_000, reason: 'seed' }] }));

  /** Start a child, let it see pongs, make its socket half-open. */
  async function driveToHalfOpen(label) {
    fake.setRespond(true);
    const before = { config: fake.count('config'), connect: fake.count('connect') };
    const c = runChild(env);
    children.push(c);
    const started = await c.waitFor((l) => l.ev === 'started', 10_000, `${label} started`);
    const t0 = Date.now();
    await waitUntil(() => fake.count('pong', t0) >= 2, 10_000, `${label} pongs`);
    assert.equal(fake.count('config') - before.config, 1, `${label}: one config pull`);
    assert.equal(fake.count('connect') - before.connect, 1, `${label}: one socket`);
    fake.setRespond(false);
    const detected = await c.waitFor(isHalfOpen, 10_000, `${label} half-open detection`);
    return { c, started, detected, before };
  }

  /** Assert a child exited 75 with nothing new between detection and exit. */
  async function assertControlledExit(label, { c, detected, before }) {
    const exit = await c.closed;
    assert.equal(exit.code, RESTART_EXIT_CODE, `${label} exit code (output:\n${c.raw.join('\n')})`);
    assert.equal(exit.signal, null);
    assert.match(detected.m, /-> requesting controlled process restart/);
    // Everything the child ever did against the server: 1 config pull, 1 socket.
    assert.equal(fake.count('config') - before.config, 1, `${label}: no config pull between detection and exit`);
    assert.equal(fake.count('connect') - before.connect, 1, `${label}: no socket between detection and exit`);
    assert.equal(c.lines.filter((l) => l.ev === 'wsclient-constructed').length, 1, `${label}: exactly one WSClient`);
    const sd = c.find((l) => l.ev === 'on-shutdown');
    assert.ok(sd, `${label}: graceful shutdown hook ran`);
    assert.equal(sd.reason, 'pong-timeout');
    assert.equal(sd.clientAfterClose, true);
    assert.equal(sd.dataCacheIntervalAlive, true, `${label}: DataCache interval alive at shutdown -> reclaimed only by exit`);
    assert.ok(c.find((l) => l.ev === 'log' && l.m.includes(`exiting with code ${RESTART_EXIT_CODE}`)));
    assert.ok(!c.raw.some((l) => /wss?:\/\//.test(l)), `${label}: ws url never logged`);
    return exit;
  }

  // ---- child 1 ----
  const r1 = await driveToHalfOpen('child1');
  assert.equal(r1.started.state.restartsInWindow, 1);
  assert.equal(r1.started.state.lastRestartReason, 'seed');
  await assertControlledExit('child1', r1);
  let st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(st.restarts.map((r) => r.reason), ['seed', 'pong-timeout']);

  // ---- child 2: supervisor restart, new PID, reads persisted state ----
  const r2 = await driveToHalfOpen('child2');
  assert.notEqual(r2.started.pid, r1.started.pid, 'new process');
  assert.equal(r2.started.state.restartsInWindow, 2);
  assert.equal(r2.started.state.lastRestartReason, 'pong-timeout');
  assert.ok(r2.c.find((l) => l.ev === 'log' && /previous watchdog restart at .*reason=pong-timeout\); 2\/3 restarts/.test(l.m)));
  await assertControlledExit('child2', r2);
  st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(st.restarts.length, 3);

  // ---- child 3: limit reached -> suppressed, keeps running (no restart storm) ----
  const r3 = await driveToHalfOpen('child3');
  assert.notEqual(r3.started.pid, r2.started.pid);
  assert.equal(r3.started.state.restartsInWindow, 3);
  assert.match(r3.detected.m, /process restart SUPPRESSED \(rate-limited: 3 restarts in last 30m \(limit 3\)/);
  const cfgAfter = fake.count('config');
  await sleep(2000);
  assert.equal(r3.c.child.exitCode, null, 'child3 still running in monitoring mode');
  assert.equal(r3.c.lines.filter(isHalfOpen).length, 1, 'suppression ERROR logged once');
  assert.equal(fake.count('config'), cfgAfter);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).restarts.length, 3, 'suppressed attempt not recorded');
  r3.c.child.kill('SIGTERM');
  const exit3 = await r3.c.closed;
  assert.equal(exit3.code, 0);
});
