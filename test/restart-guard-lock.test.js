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
 * - NO automatic stale-lock takeover: dead-pid, live-pid and unknown-owner
 *   locks are all refused (fail-closed) and left untouched; the holder is
 *   only classified for reporting. Release-on-every-path with ownership
 *   check, non-blocking wait.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createRestartGuard, classifyLockOwner, lockRecoveryHint, writeAllSync, RESTART_MAX_IN_WINDOW, LOCK_TIMEOUT_MS } from '../src/lib/transport/restart-guard.js';

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

const HOUR = 60 * 60_000;

test('no takeover, ever: dead-pid (even hours old), live-pid and unknown-owner locks -> lock-unavailable, lock untouched, holder classified', async () => {
  const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    const dead = deadPid();
    const cases = [
      ['dead pid, 2h old', { pid: dead, acquiredAt: 'x', token: 'x' }, 2 * HOUR, 'held-by-dead-pid', dead],
      ['dead pid, fresh', { pid: dead, token: 'x' }, 0, 'held-by-dead-pid', dead],
      ['live pid, 2h old (possible pid reuse)', { pid: live.pid, token: 'x' }, 2 * HOUR, 'held-by-live-pid', live.pid],
      ['live pid, fresh', { pid: live.pid, token: 'x' }, 0, 'held-by-live-pid', live.pid],
      ['{} (no pid)', {}, 2 * HOUR, 'unknown-owner', null],
      ['string pid', { pid: String(dead) }, 2 * HOUR, 'unknown-owner', null],
      ['zero pid', { pid: 0 }, 2 * HOUR, 'unknown-owner', null],
      ['negative pid', { pid: -1 }, 2 * HOUR, 'unknown-owner', null],
      ['non-integer pid', { pid: 12.5 }, 2 * HOUR, 'unknown-owner', null],
      ['empty file (crash between create and write)', '', 2 * HOUR, 'unknown-owner', null],
      ['unparseable', '{garbage', 2 * HOUR, 'unknown-owner', null],
    ];
    if (process.getuid && process.getuid() !== 0) {
      cases.push(['pid 1 -> EPERM counts as live', { pid: 1, token: 'x' }, 2 * HOUR, 'held-by-live-pid', 1]);
    }
    for (const [label, content, age, expectState, expectPid] of cases) {
      const dir = tmpDir();
      const file = path.join(dir, 'ws-restart-state.json');
      const lock = writeLock(file, content, age);
      const before = fs.readFileSync(lock, 'utf8');
      const mtimeBefore = fs.statSync(lock).mtimeMs;
      // Spy: diagnose-only (no unlink/rename/link of the foreign lock) and the
      // ledger transaction is never entered (state file not read/written).
      const touched = [];
      const spyFs = {
        ...fs,
        unlinkSync: (p) => { touched.push(['unlink', p]); return fs.unlinkSync(p); },
        renameSync: (a, b) => { touched.push(['rename', a, b]); return fs.renameSync(a, b); },
        linkSync: (a, b) => { touched.push(['link', a, b]); return fs.linkSync(a, b); },
        readFileSync: (p, ...r) => { if (p === file) touched.push(['read-ledger']); return fs.readFileSync(p, ...r); },
        openSync: (p, ...r) => { if (p !== lock) touched.push(['open', p]); return fs.openSync(p, ...r); },
      };
      const guard = createRestartGuard({ file, fs: spyFs, lockTimeoutMs: 150 });
      const t0 = Date.now();
      const v = await guard.tryAcquire('pong-timeout');
      assert.equal(v.allowed, false, label);
      assert.equal(v.cause, 'lock-unavailable', label);
      assert.ok(Date.now() - t0 >= 150, `${label}: waited the full timeout`);
      assert.equal(v.lock.lockPath, lock, label);
      assert.equal(v.lock.lockState, expectState, label);
      assert.equal(v.lock.lockOwnerPid, expectPid, label);
      assert.ok(Math.abs(v.lock.lockAgeSec - age / 1000) <= 2, `${label}: age ${v.lock.lockAgeSec}s`);
      assert.match(v.detail, new RegExp(`lock busy for 150ms \\(${expectState}, pid ${expectPid ?? 'unknown'}, age \\d+s\\)`), label);
      assert.deepEqual(guard.inspectLock(), { ...v.lock, lockAgeSec: guard.inspectLock().lockAgeSec }, label);
      assert.ok(!v.detail.includes('"token"') && !JSON.stringify(v.lock).includes('token'), `${label}: no token exposed`);
      assert.equal(fs.readFileSync(lock, 'utf8'), before, `${label}: lock content untouched`);
      assert.equal(fs.statSync(lock).mtimeMs, mtimeBefore, `${label}: lock not rewritten`);
      assert.equal(fs.existsSync(file), false, `${label}: ledger not touched without the lock`);
      assert.deepEqual(touched, [], `${label}: no unlink/rename/link, no ledger read/write`);
      assert.deepEqual(leftovers(dir), ['ws-restart-state.json.lock'], `${label}: nothing else created`);
    }
  } finally {
    live.kill('SIGKILL');
  }
});

test('classifyLockOwner (reporting only) and inspectLock on a free lock', () => {
  assert.equal(classifyLockOwner(process.pid), 'held-by-live-pid');
  assert.equal(classifyLockOwner(deadPid()), 'held-by-dead-pid');
  for (const p of [undefined, null, 0, -5, 1.5, '123', NaN]) assert.equal(classifyLockOwner(p), 'unknown-owner');
  const file = path.join(tmpDir(), 'ws-restart-state.json');
  assert.deepEqual(createRestartGuard({ file }).inspectLock(), { lockPath: `${file}.lock`, lockState: 'free', lockOwnerPid: null, lockAgeSec: null, lockError: null });
});

test('once the operator removes the blocking lock, the next acquisition succeeds', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'ws-restart-state.json');
  const lock = writeLock(file, { pid: deadPid(), token: 'x' }, 2 * HOUR);
  const guard = createRestartGuard({ file, lockTimeoutMs: 100 });
  assert.equal((await guard.tryAcquire('r')).cause, 'lock-unavailable');
  fs.unlinkSync(lock); // manual recovery
  assert.equal((await guard.tryAcquire('r')).allowed, true);
  assert.deepEqual(leftovers(dir), []);
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
  // lock init failure after a successful O_EXCL create: the pathname was
  // replaced by another process before our write -> fail closed and the
  // replacement lock is NOT deleted
  {
    const { dir, file } = mk();
    const lock = `${file}.lock`;
    const foreign = JSON.stringify({ pid: 424242, token: 'FOREIGN' });
    let injected = false;
    const swapFs = {
      ...fs,
      writeSync: (fd, ...a) => {
        if (!injected) {
          injected = true;
          fs.unlinkSync(lock);
          fs.writeFileSync(lock, foreign); // someone else now owns the path
          const e = new Error('EIO'); e.code = 'EIO'; throw e;
        }
        return fs.writeSync(fd, ...a);
      },
    };
    const v = await createRestartGuard({ file, fs: swapFs, lockTimeoutMs: 50 }).tryAcquire('r');
    assert.equal(v.allowed, false);
    assert.equal(v.cause, 'lock-unavailable');
    assert.match(v.detail, /EIO/);
    assert.equal(fs.readFileSync(lock, 'utf8'), foreign, 'replacement lock left intact');
    assert.equal(fs.existsSync(file), false, 'ledger not touched');
    assert.deepEqual(leftovers(dir), ['ws-restart-state.json.lock']);
  }
  // lock init failure without a replacement: our partial (empty) lock stays
  // in place (fail-closed) and is reported as unknown-owner/empty
  {
    const { file } = mk();
    const lock = `${file}.lock`;
    const eioFs = { ...fs, fsyncSync: () => { const e = new Error('EIO'); e.code = 'EIO'; throw e; } };
    const g = createRestartGuard({ file, fs: eioFs, lockTimeoutMs: 50 });
    const v = await g.tryAcquire('r');
    assert.equal(v.cause, 'lock-unavailable');
    assert.ok(fs.existsSync(lock), 'not unlinked by path');
    const obs = g.inspectLock();
    assert.equal(obs.lockState, 'held-by-self', 'our pid + a token we minted (content written before fsync failed)');
    assert.equal(obs.lockOwnerPid, process.pid);
    assert.equal(lockRecoveryHint(obs), `this zylos-lark process holds it: run \`pm2 stop zylos-lark\`, confirm \`ps -p ${process.pid}\` no longer shows that pid and \`pm2 ls\` shows no running zylos-lark, then remove ${lock}, then \`pm2 start zylos-lark\``);
    assert.equal(fs.readFileSync(lock, 'utf8').length > 0, true, 'held-by-self is never auto-deleted');
    // another guard instance (did not mint that token) sees our pid as a live foreign holder
    assert.equal(createRestartGuard({ file }).inspectLock().lockState, 'held-by-live-pid');
    const g2 = createRestartGuard({ file, lockTimeoutMs: 50 });
    assert.equal((await g2.tryAcquire('r')).cause, 'lock-unavailable', 'stays blocked until manual recovery');
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

/**
 * fs seam that turns writes on the lock fd or the ledger temp fd into short
 * writes. plan: array of per-call behaviours for that target:
 *   'half' -> write half of the remaining bytes, return that count
 *   'zero' -> write nothing, return 0
 *   'rest' -> write everything remaining (normal)
 */
function shortWriteFs(target, plan) {
  const fdPath = new Map();
  let calls = 0;
  return {
    ...fs,
    openSync: (p, ...a) => { const fd = fs.openSync(p, ...a); fdPath.set(fd, p); return fd; },
    writeSync: (fd, buf, off = 0, len = buf.length - off, ...r) => {
      const p = fdPath.get(fd) || '';
      const hit = target === 'lock' ? p.endsWith('.lock') : p.endsWith('.tmp');
      if (!hit) return fs.writeSync(fd, buf, off, len, ...r);
      const step = plan[calls++] ?? 'rest';
      if (step === 'zero') return 0;
      if (step === 'half') return fs.writeSync(fd, buf, off, Math.max(1, Math.floor(len / 2)));
      return fs.writeSync(fd, buf, off, len);
    },
  };
}

test('short write of the lock body -> refused, ledger untouched, partial lock kept', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'ws-restart-state.json');
  seed(file, 1);
  const before = fs.readFileSync(file, 'utf8');
  const g = createRestartGuard({ file, fs: shortWriteFs('lock', ['half', 'zero']), lockTimeoutMs: 50 });
  const v = await g.tryAcquire('pong-timeout');
  assert.equal(v.allowed, false);
  assert.equal(v.cause, 'lock-unavailable');
  assert.match(v.detail, /ESHORTWRITE/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'ledger not read-modified-written');
  assert.ok(fs.existsSync(`${file}.lock`), 'partial lock kept (ownership-safe)');
  const obs = createRestartGuard({ file }).inspectLock();
  assert.equal(obs.lockState, 'unknown-owner');
  assert.equal(obs.lockError, 'unparseable');
});

test('short write of the ledger temp file -> refused, ledger unchanged and parseable, no temp, lock released', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'ws-restart-state.json');
  seed(file, 1);
  const before = fs.readFileSync(file, 'utf8');
  const g = createRestartGuard({ file, fs: shortWriteFs('ledger', ['half', 'zero']) });
  const v = await g.tryAcquire('pong-timeout');
  assert.equal(v.allowed, false);
  assert.equal(v.cause, 'write-failed');
  assert.match(v.detail, /ESHORTWRITE/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(readLedger(file).length, 1, 'still the previous, parseable state');
  assert.deepEqual(leftovers(dir), [], 'no temp file, lock released');
  assert.equal((await createRestartGuard({ file }).tryAcquire('pong-timeout')).allowed, true, 'next guard is not blocked');
});

test('short writes that complete on retry -> success with intact lock and ledger content', async () => {
  for (const target of ['lock', 'ledger']) {
    const dir = tmpDir();
    const file = path.join(dir, 'ws-restart-state.json');
    seed(file, 1);
    let lockSeen = null;
    const base = shortWriteFs(target, ['half', 'half', 'rest']);
    const spy = { ...base, fsyncSync: (fd) => { try { lockSeen ??= JSON.parse(fs.readFileSync(`${file}.lock`, 'utf8')); } catch { /* not yet */ } return fs.fsyncSync(fd); } };
    const v = await createRestartGuard({ file, fs: spy }).tryAcquire('pong-timeout');
    assert.equal(v.allowed, true, target);
    const ledger = readLedger(file);
    assert.equal(ledger.length, 2, `${target}: ledger complete and parseable`);
    assert.equal(ledger.at(-1).reason, 'pong-timeout');
    assert.equal(ledger.at(-1).pid, process.pid);
    assert.equal(lockSeen.pid, process.pid, `${target}: lock body was complete JSON`);
    assert.equal(typeof lockSeen.token, 'string');
    assert.deepEqual(leftovers(dir), [], `${target}: lock released (token parsed), no temp`);
  }
});

test('writeAllSync: loops over partial writes, throws on zero progress', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'x');
  const fd = fs.openSync(p, 'w');
  const seq = [3, 0];
  const fake = { writeSync: (f, buf, off, len) => fs.writeSync(f, buf, off, Math.min(len, seq.length ? seq.shift() || 0 : len)) };
  assert.throws(() => writeAllSync(fake, fd, 'abcdefgh'), /short write: 3\/8/);
  fs.closeSync(fd);
  const fd2 = fs.openSync(p, 'w');
  let k = 0;
  const partial = { writeSync: (f, buf, off, len) => fs.writeSync(f, buf, off, Math.min(len, ++k)) };
  assert.equal(writeAllSync(partial, fd2, 'abcdefgh'), 8);
  fs.closeSync(fd2);
  assert.equal(fs.readFileSync(p, 'utf8'), 'abcdefgh');
});
