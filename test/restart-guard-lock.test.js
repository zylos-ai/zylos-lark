/**
 * Cross-process lock around the restart-guard acquisition transaction.
 *
 * - Real concurrency: 8 real child processes released by a file barrier
 *   compete for the single remaining slot (ledger pre-seeded with 2 of 3),
 *   5 rounds. Exactly one may win and the ledger must hold exactly 3 entries
 *   with the winner's record.
 * - Mutation check: the same scenario with the test-only mutants
 *   `_lockMode: 'none'` (no lock) and `'write-only'` (lock moved outside the
 *   read/decide part) MUST over-admit — proving the regression discriminates.
 * - Stale takeover, live/unknown holders (fail-closed), rename races,
 *   release-on-every-path with ownership check, non-blocking wait.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createRestartGuard, RESTART_MAX_IN_WINDOW, LOCK_TIMEOUT_MS, LOCK_STALE_MS } from '../src/lib/transport/restart-guard.js';

const CONTENDER = fileURLToPath(new URL('./fixtures/guard-contender.mjs', import.meta.url));
const CONTENDERS = 8;
const ROUNDS = 5;
const WIDEN_MS = 100; // same race window for locked and mutant runs; 8 x 100ms < LOCK_TIMEOUT_MS

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lark-guard-lock-'));
}
function seed(file, n) {
  const t = Date.now();
  fs.writeFileSync(file, JSON.stringify({ version: 1, restarts: Array.from({ length: n }, (_, i) => ({ at: t - (i + 1) * 60_000, reason: 'seed' })) }));
}
const readLedger = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).restarts;
const leftovers = (dir) => fs.readdirSync(dir).filter((f) => f !== 'ws-restart-state.json' && f !== 'go');
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
function writeLock(file, content, ageMs = 0) {
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, typeof content === 'string' ? content : JSON.stringify(content));
  if (ageMs) {
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(lock, t, t);
  }
  return lock;
}

/** One round: 8 children, barrier, all call tryAcquire concurrently. */
async function runRound(lockMode) {
  const dir = tmpDir();
  const file = path.join(dir, 'ws-restart-state.json');
  const go = path.join(dir, 'go');
  seed(file, RESTART_MAX_IN_WINDOW - 1); // exactly one slot left
  const kids = Array.from({ length: CONTENDERS }, () => {
    const child = spawn(process.execPath, [CONTENDER], {
      env: { ...process.env, STATE_FILE: file, GO_FILE: go, LOCK_MODE: lockMode, WIDEN_MS: String(WIDEN_MS) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const ready = new Promise((resolve) => {
      const check = () => (out.includes('ready\n') ? resolve() : setTimeout(check, 5));
      check();
    });
    const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
    return { child, ready, done };
  });
  await Promise.all(kids.map((k) => k.ready));
  fs.writeFileSync(go, ''); // release the barrier
  const results = await Promise.all(kids.map((k) => k.done));
  const verdicts = results.map((r) => {
    assert.equal(r.code, 0, r.err);
    return JSON.parse(r.out.trim().split('\n').at(-1));
  });
  return { dir, file, verdicts, ledger: readLedger(file) };
}

test(`8 real processes, 1 slot left, ${ROUNDS} rounds: exactly one wins, ledger has exactly 3 entries`, { timeout: 120_000 }, async () => {
  for (let round = 1; round <= ROUNDS; round++) {
    const { dir, verdicts, ledger } = await runRound('full');
    const winners = verdicts.filter((v) => v.verdict.allowed);
    const losers = verdicts.filter((v) => !v.verdict.allowed);
    assert.equal(winners.length, 1, `round ${round}: exactly one allowed (${JSON.stringify(verdicts.map((v) => v.verdict.cause || 'allowed'))})`);
    assert.equal(losers.length, CONTENDERS - 1);
    for (const l of losers) assert.equal(l.verdict.cause, 'rate-limited', `round ${round}: losers re-read the ledger inside the lock`);
    assert.equal(ledger.length, RESTART_MAX_IN_WINDOW, `round ${round}: ledger has exactly 3 entries`);
    assert.equal(ledger.filter((e) => e.reason === 'seed').length, 2, 'seed entries preserved');
    assert.equal(ledger.at(-1).reason, 'pong-timeout');
    assert.equal(ledger.at(-1).pid, winners[0].pid, "the winner's record is the one persisted");
    assert.deepEqual(leftovers(dir), [], `round ${round}: no lock / tombstone / temp left behind`);
  }
});

for (const mutant of ['none', 'write-only']) {
  test(`mutation check: lock mode '${mutant}' over-admits in the same scenario (the regression discriminates)`, { timeout: 60_000 }, async () => {
    const { verdicts, ledger } = await runRound(mutant);
    const winners = verdicts.filter((v) => v.verdict.allowed);
    assert.ok(winners.length > 1, `mutant '${mutant}' should admit more than one, got ${winners.length}`);
    assert.ok(ledger.length <= RESTART_MAX_IN_WINDOW, 'and the ledger lost the extra winners (overwritten)');
  });
}

test('stale lock from a dead pid is taken over; no lock or tombstone left', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'ws-restart-state.json');
  writeLock(file, { pid: deadPid(), acquiredAt: new Date().toISOString(), token: 'old' }, LOCK_STALE_MS + 5_000);
  const guard = createRestartGuard({ file, lockTimeoutMs: 300 });
  const v = await guard.tryAcquire('pong-timeout');
  assert.equal(v.allowed, true);
  assert.deepEqual(leftovers(dir), []);
});

test('fail-closed: live holder (old or fresh), unparseable lock, fresh dead-pid lock, EPERM -> lock-unavailable, lock untouched', async () => {
  const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    const cases = [
      ['live pid, old lock (possible pid reuse is not proof of death)', { pid: live.pid, token: 'x' }, LOCK_STALE_MS + 5_000],
      ['live pid, fresh lock', { pid: live.pid, token: 'x' }, 0],
      ['dead pid but lock younger than stale threshold', { pid: deadPid(), token: 'x' }, 0],
      ['unparseable old lock (liveness unknown)', '{garbage', LOCK_STALE_MS + 5_000],
    ];
    if (process.getuid && process.getuid() !== 0) {
      cases.push(['pid 1 -> EPERM (cannot prove dead)', { pid: 1, token: 'x' }, LOCK_STALE_MS + 5_000]);
    }
    for (const [label, content, age] of cases) {
      const dir = tmpDir();
      const file = path.join(dir, 'ws-restart-state.json');
      const lock = writeLock(file, content, age);
      const before = fs.readFileSync(lock, 'utf8');
      const guard = createRestartGuard({ file, lockTimeoutMs: 300 });
      const t0 = Date.now();
      const v = await guard.tryAcquire('pong-timeout');
      assert.equal(v.allowed, false, label);
      assert.equal(v.cause, 'lock-unavailable', label);
      assert.match(v.detail, /cannot lock restart state: lock busy for 300ms/, label);
      assert.ok(Date.now() - t0 >= 300, `${label}: waited the full timeout`);
      assert.equal(fs.readFileSync(lock, 'utf8'), before, `${label}: holder's lock untouched`);
      assert.equal(fs.existsSync(file), false, `${label}: ledger not touched without the lock`);
      assert.deepEqual(leftovers(dir), ['ws-restart-state.json.lock'], `${label}: no tombstones`);
    }
  } finally {
    live.kill('SIGKILL');
  }
});

test('lock wait does not block the event loop; default timeout is bounded', async () => {
  assert.ok(LOCK_TIMEOUT_MS <= 2_000);
  const dir = tmpDir();
  const file = path.join(dir, 'ws-restart-state.json');
  writeLock(file, { pid: process.pid, token: 'held' });
  let ticks = 0;
  const iv = setInterval(() => { ticks++; }, 10);
  const v = await createRestartGuard({ file, lockTimeoutMs: 400 }).tryAcquire('pong-timeout');
  clearInterval(iv);
  assert.equal(v.cause, 'lock-unavailable');
  assert.ok(ticks >= 20, `event loop kept running during the wait (${ticks} ticks)`);
});

test('stale takeover races: rename ENOENT -> re-compete from scratch; wrong inode -> restored, back off', async () => {
  // (a) someone else removed the stale lock between our check and rename
  {
    const dir = tmpDir();
    const file = path.join(dir, 'ws-restart-state.json');
    const lock = writeLock(file, { pid: deadPid(), token: 'old' }, LOCK_STALE_MS + 5_000);
    let reads = 0;
    const racyFs = {
      ...fs,
      readFileSync: (p, ...a) => { if (p === file) reads++; return fs.readFileSync(p, ...a); },
      renameSync: (a, b) => {
        if (a === lock && b.includes('.stale.')) {
          fs.unlinkSync(lock);
          const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
        }
        return fs.renameSync(a, b);
      },
    };
    const v = await createRestartGuard({ file, fs: racyFs, lockTimeoutMs: 300 }).tryAcquire('pong-timeout');
    assert.equal(v.allowed, true, 're-competed and acquired a fresh lock');
    assert.equal(reads, 1, 'ledger read exactly once, only after holding the lock');
    assert.deepEqual(leftovers(dir), []);
  }
  // (b) a newer holder replaced the stale lock right before our rename
  {
    const dir = tmpDir();
    const file = path.join(dir, 'ws-restart-state.json');
    const lock = writeLock(file, { pid: deadPid(), token: 'old' }, LOCK_STALE_MS + 5_000);
    const fresh = JSON.stringify({ pid: process.pid, token: 'newer-holder' });
    let swapped = false;
    const racyFs = {
      ...fs,
      renameSync: (a, b) => {
        if (!swapped && a === lock && b.includes('.stale.')) {
          swapped = true;
          fs.unlinkSync(lock);
          fs.writeFileSync(lock, fresh); // new inode, live holder
        }
        return fs.renameSync(a, b);
      },
    };
    const v = await createRestartGuard({ file, fs: racyFs, lockTimeoutMs: 300 }).tryAcquire('pong-timeout');
    assert.equal(v.cause, 'lock-unavailable');
    assert.equal(fs.readFileSync(lock, 'utf8'), fresh, "newer holder's lock restored intact");
    assert.deepEqual(leftovers(dir), ['ws-restart-state.json.lock'], 'our tombstone removed, nothing else');
    assert.equal(fs.existsSync(file), false);
  }
});

test('release on every path, only our own lock', async () => {
  const mk = () => { const dir = tmpDir(); return { dir, file: path.join(dir, 'ws-restart-state.json') }; };

  // normal
  {
    const { dir, file } = mk();
    assert.equal((await createRestartGuard({ file }).tryAcquire('r')).allowed, true);
    assert.deepEqual(leftovers(dir), []);
  }
  // exception inside the transaction
  {
    const { dir, file } = mk();
    const v = await createRestartGuard({ file, _afterRead: () => { throw new Error('boom'); } }).tryAcquire('r');
    assert.equal(v.allowed, false);
    assert.equal(v.cause, 'guard-error');
    assert.deepEqual(leftovers(dir), []);
  }
  // write failure (rename of the ledger temp file fails)
  {
    const { dir, file } = mk();
    const badFs = { ...fs, renameSync: (a, b) => { if (b === file) { const e = new Error('EXDEV'); e.code = 'EXDEV'; throw e; } return fs.renameSync(a, b); } };
    const v = await createRestartGuard({ file, fs: badFs }).tryAcquire('r');
    assert.equal(v.cause, 'write-failed');
    assert.deepEqual(leftovers(dir), []);
  }
  // corrupt ledger path
  {
    const { dir, file } = mk();
    fs.writeFileSync(file, '{bad');
    assert.equal((await createRestartGuard({ file }).tryAcquire('r')).cause, 'corrupt');
    assert.deepEqual(leftovers(dir), []);
  }
  // lock replaced by someone else mid-transaction -> never removed by us
  {
    const { dir, file } = mk();
    const foreign = JSON.stringify({ pid: 999999, token: 'someone-else' });
    const v = await createRestartGuard({ file, _afterRead: () => fs.writeFileSync(`${file}.lock`, foreign) }).tryAcquire('r');
    assert.equal(v.allowed, true);
    assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), foreign, "a lock that is not ours is left alone");
    assert.deepEqual(leftovers(dir), ['ws-restart-state.json.lock']);
  }
  // lock file cannot be created at all -> fail-closed, distinct cause
  {
    const { file } = mk();
    const roFs = { ...fs, openSync: (p, ...a) => { if (p.endsWith('.lock')) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } return fs.openSync(p, ...a); } };
    const v = await createRestartGuard({ file, fs: roFs }).tryAcquire('r');
    assert.equal(v.cause, 'lock-unavailable');
    assert.match(v.detail, /EACCES/);
    assert.equal(fs.existsSync(file), false);
  }
});
