/**
 * Cross-process rate limit for watchdog-initiated process restarts.
 *
 * The half-open watchdog (websocket.js) recovers by exiting the process and
 * letting PM2 start a fresh one. Every restart is recorded in a small JSON
 * state file in the component data dir so the limit survives the restart:
 *
 *   ~/zylos/components/lark/ws-restart-state.json
 *   { "version": 1, "restarts": [ { "at": <epoch ms>, "reason": "pong-timeout" }, ... ] }
 *
 * Rules (fail-safe — any doubt means "do not restart"):
 * - At most RESTART_MAX_IN_WINDOW restarts within RESTART_WINDOW_MS. When the
 *   limit is reached the restart is refused until the oldest entry ages out.
 * - Missing file (ENOENT) = no previous restarts.
 * - Unreadable / unparseable / wrongly shaped file = treated as "limit
 *   reached": the restart is refused and the file is overwritten with a full
 *   window of synthetic `state-file-corrupt` entries, so restarts resume only
 *   after one full window (self-healing, never a storm). If that rewrite also
 *   fails the refusal simply repeats one window later.
 * - The restart is only allowed once its own record has been persisted. If
 *   the write fails (unwritable dir, disk full, ...) the restart is refused,
 *   because an unrecorded restart would escape the limit.
 * - Entries with a timestamp in the future (clock stepped backwards) are
 *   counted as inside the window (conservative).
 * - Writes are atomic: temp file in the same directory, fsync, rename.
 *
 * Cross-process serialization: the whole acquisition transaction
 * (read -> decide -> persist) runs under an exclusive lock file
 * `<state file>.lock`, created with open(O_CREAT|O_EXCL) ('wx') and holding
 * { pid, acquiredAt, token } (token = random, unique per acquisition).
 * Without it, N processes could all read the same old ledger, all take the
 * last slot and overwrite each other.
 * - Acquisition is async: on EEXIST it retries after jittered setTimeout
 *   sleeps (LOCK_RETRY_MIN_MS..LOCK_RETRY_MAX_MS) up to LOCK_TIMEOUT_MS, so the
 *   event loop is never blocked. The critical section is a few ms of local
 *   synchronous I/O. State is only read AFTER the lock is held.
 * - Stale takeover only if the lock is older than LOCK_STALE_MS (mtime) AND
 *   its holder is provably dead: parseable content with a pid for which
 *   process.kill(pid, 0) throws ESRCH. Live pid (incl. possible pid reuse),
 *   EPERM, or unparseable content = treated as alive -> no takeover
 *   (fail-closed). Takeover renames the lock to a unique tombstone (atomic:
 *   only one contender can move it); ENOENT or any rename failure -> go back
 *   to competing from scratch. If the moved inode is not the one judged
 *   stale, it is restored with link() and we back off. Only our own tombstone
 *   is unlinked.
 * - Release in `finally` on every path, and only if the lock file still
 *   carries our token — a newer holder's lock is never removed.
 * - Fail-closed: lock timeout or any lock error -> this restart attempt is
 *   refused with cause 'lock-unavailable' (distinct from 'corrupt'); the
 *   caller keeps monitoring and retries later. Nothing proceeds without the
 *   lock.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

export const RESTART_STATE_FILENAME = 'ws-restart-state.json';
/** Max watchdog restarts allowed inside one window. */
export const RESTART_MAX_IN_WINDOW = 3;
/** Sliding window for RESTART_MAX_IN_WINDOW. */
export const RESTART_WINDOW_MS = 30 * 60_000;
export const CORRUPT_REASON = 'state-file-corrupt';
/** Max time to wait for the cross-process lock before refusing (fail-closed). */
export const LOCK_TIMEOUT_MS = 2_000;
/** A lock older than this whose holder pid is dead may be taken over. */
export const LOCK_STALE_MS = 10_000;
export const LOCK_RETRY_MIN_MS = 5;
export const LOCK_RETRY_MAX_MS = 25;
/** After a lock-unavailable refusal, re-evaluate this much later. */
export const LOCK_RETRY_AFTER_MS = 60_000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH'; // EPERM / unknown = cannot prove dead -> alive
  }
}

const STATE_VERSION = 1;

function isValidState(obj) {
  return obj !== null
    && typeof obj === 'object'
    && !Array.isArray(obj)
    && Array.isArray(obj.restarts)
    && obj.restarts.every((r) => r && typeof r === 'object' && Number.isFinite(r.at));
}

/**
 * @param {object} opts
 * @param {string} opts.file - absolute path of the state file
 * @param {object} [opts.fs] - fs implementation (injectable for tests)
 * @param {function} [opts.now]
 * @param {number} [opts.maxInWindow]
 * @param {number} [opts.windowMs]
 * @param {number} [opts.lockTimeoutMs]
 * @param {number} [opts.lockStaleMs]
 */
export function createRestartGuard({
  file,
  fs = nodeFs,
  now = () => Date.now(),
  maxInWindow = RESTART_MAX_IN_WINDOW,
  windowMs = RESTART_WINDOW_MS,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
  lockStaleMs = LOCK_STALE_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // TEST-ONLY mutation hooks (never set in production):
  //   _lockMode: 'full' (default) | 'none' | 'write-only'
  //   _afterRead: (async) fn run inside the transaction between read and write
  _lockMode = 'full',
  _afterRead = null,
} = {}) {
  if (!file) throw new Error('restart guard: state file path required');
  const lockFile = `${file}.lock`;
  let tmpSeq = 0;
  let lockSeq = 0;
  /** Last successfully read/written entries (for /health). */
  let cached = [];
  /** Last load problem (null when the file was fine or missing). */
  let lastError = null;

  /** @returns {{ ok: true, restarts: object[] } | { ok: false, error: string }} */
  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        cached = [];
        lastError = null;
        return { ok: true, restarts: [] };
      }
      lastError = `unreadable (${err?.code || err?.message || 'error'})`;
      return { ok: false, error: lastError };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      lastError = 'unparseable JSON';
      return { ok: false, error: lastError };
    }
    if (!isValidState(parsed)) {
      lastError = 'unexpected shape';
      return { ok: false, error: lastError };
    }
    cached = parsed.restarts.map((r) => ({
      at: r.at,
      reason: typeof r.reason === 'string' ? r.reason : 'unknown',
      ...(Number.isInteger(r.pid) ? { pid: r.pid } : {}),
    }));
    lastError = null;
    return { ok: true, restarts: cached };
  }

  /** Atomic write: same-dir temp file + fsync + rename. Throws on failure. */
  function write(restarts) {
    const dir = path.dirname(file);
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${++tmpSeq}.tmp`);
    const body = JSON.stringify({ version: STATE_VERSION, restarts }, null, 2) + '\n';
    let fd = null;
    try {
      fd = fs.openSync(tmp, 'w', 0o600);
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, file);
    } catch (err) {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }
    cached = restarts;
  }

  function readLock() {
    const st = fs.statSync(lockFile);
    let raw = null;
    let info = null;
    try { raw = fs.readFileSync(lockFile, 'utf8'); info = JSON.parse(raw); } catch { /* empty / partial */ }
    return { st, raw, info };
  }

  /**
   * Try to take over a stale lock. Returns true when the lock path was freed
   * (by us or someone else) and the caller should re-compete immediately.
   */
  function breakStaleLock() {
    let cur;
    try { cur = readLock(); } catch (err) { return err?.code === 'ENOENT'; }
    if (Date.now() - cur.st.mtimeMs <= lockStaleMs) return false;
    if (!cur.info || pidAlive(cur.info.pid)) return false; // cannot prove dead
    const tomb = `${lockFile}.stale.${process.pid}.${++lockSeq}.${Math.random().toString(36).slice(2)}`;
    try {
      fs.renameSync(lockFile, tomb); // atomic: only one contender moves it
    } catch (err) {
      return err?.code === 'ENOENT'; // gone already -> re-compete; else back off
    }
    // Same file we judged stale? Inode numbers are reused immediately, so
    // also compare mtime and the exact content (tokens are unique).
    let same = false;
    try {
      const moved = fs.statSync(tomb);
      same = moved.ino === cur.st.ino && moved.mtimeMs === cur.st.mtimeMs
        && fs.readFileSync(tomb, 'utf8') === cur.raw;
    } catch { /* treat as not ours */ }
    if (!same) {
      // We moved a newer holder's lock (it replaced the stale one between our
      // check and rename). Put it back; if that fails leave it untouched.
      try {
        fs.linkSync(tomb, lockFile);
        fs.unlinkSync(tomb); // lock still reachable via lockFile
      } catch { /* leave the newer holder's file alone */ }
      return false;
    }
    try { fs.unlinkSync(tomb); } catch { /* ignore */ } // our own tombstone
    return true;
  }

  /** Acquire the exclusive lock or throw (fail-closed). Resolves to our token. */
  async function acquireLock() {
    const token = `${process.pid}.${Date.now()}.${++lockSeq}.${Math.random().toString(36).slice(2)}`;
    const body = JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), token });
    const deadline = Date.now() + lockTimeoutMs;
    for (;;) {
      let fd = null;
      try {
        fd = fs.openSync(lockFile, 'wx', 0o600);
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
      }
      if (fd !== null) {
        try {
          fs.writeSync(fd, body);
          fs.fsyncSync(fd);
          fs.closeSync(fd);
        } catch (err) {
          try { fs.closeSync(fd); } catch { /* ignore */ }
          try { fs.unlinkSync(lockFile); } catch { /* ours: created by this O_EXCL open */ }
          throw err;
        }
        return token;
      }
      if (breakStaleLock()) continue;
      if (Date.now() >= deadline) {
        const e = new Error(`lock busy for ${lockTimeoutMs}ms`);
        e.code = 'ELOCKTIMEOUT';
        throw e;
      }
      await sleep(LOCK_RETRY_MIN_MS + Math.random() * (LOCK_RETRY_MAX_MS - LOCK_RETRY_MIN_MS));
    }
  }

  /** Remove the lock only if it is still ours (token match). */
  function releaseLock(token) {
    if (!token) return;
    try {
      const info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (info?.token === token) fs.unlinkSync(lockFile);
    } catch { /* not ours / already gone */ }
  }

  function inWindow(restarts, t = now()) {
    return restarts.filter((r) => t - r.at < windowMs).sort((a, b) => a.at - b.at);
  }

  /**
   * Decide whether a restart may happen now and, if so, persist its record.
   * @returns {{ allowed: true, restartsInWindow: number }
   *   | { allowed: false, cause: 'rate-limited'|'corrupt'|'write-failed', detail: string, retryAt: number, restartsInWindow: number|null }}
   */
  async function tryAcquire(reason) {
    const lockUnavailable = (err) => ({
      allowed: false,
      cause: 'lock-unavailable',
      detail: `cannot lock restart state: ${err?.code === 'ELOCKTIMEOUT' ? err.message : err?.code || err?.message || 'error'}`,
      retryAt: now() + LOCK_RETRY_AFTER_MS,
      restartsInWindow: null,
    });
    let token = null;
    try {
      if (_lockMode === 'full') token = await acquireLock();
    } catch (err) {
      return lockUnavailable(err);
    }
    try {
      return await acquireLocked(reason);
    } catch (err) {
      return {
        allowed: false,
        cause: 'guard-error',
        detail: `restart guard error: ${err?.message || err}`,
        retryAt: now() + LOCK_RETRY_AFTER_MS,
        restartsInWindow: null,
      };
    } finally {
      releaseLock(token);
    }
  }

  /** read -> decide -> persist; must run under the lock. */
  async function acquireLocked(reason) {
    const t = now();
    const loaded = load();
    if (_afterRead) await _afterRead();
    if (!loaded.ok) {
      let healed = false;
      try {
        write(Array.from({ length: maxInWindow }, () => ({ at: t, reason: CORRUPT_REASON })));
        healed = true;
      } catch { /* stays refused; re-evaluated one window later */ }
      return {
        allowed: false,
        cause: 'corrupt',
        detail: `state file ${loaded.error}${healed ? '; reset to a full window' : '; reset failed'}`,
        retryAt: t + windowMs,
        restartsInWindow: null,
      };
    }
    const recent = inWindow(loaded.restarts, t);
    if (recent.length >= maxInWindow) {
      // Count drops below the limit once this entry ages out of the window.
      const pivot = recent[recent.length - maxInWindow];
      return {
        allowed: false,
        cause: 'rate-limited',
        detail: `${recent.length} restarts in last ${Math.round(windowMs / 60_000)}m (limit ${maxInWindow})`,
        retryAt: pivot.at + windowMs,
        restartsInWindow: recent.length,
      };
    }
    let wToken = null;
    try {
      if (_lockMode === 'write-only') wToken = await acquireLock();
      write([...recent, { at: t, reason, pid: process.pid }]);
    } catch (err) {
      return {
        allowed: false,
        cause: 'write-failed',
        detail: `cannot persist restart record (${err?.code || err?.message || 'error'})`,
        retryAt: t + windowMs,
        restartsInWindow: recent.length,
      };
    } finally {
      releaseLock(wToken);
    }
    return { allowed: true, restartsInWindow: recent.length + 1 };
  }

  /** Cached view for /health (no I/O). */
  function snapshot() {
    const recent = inWindow(cached);
    const last = cached.length ? cached.reduce((a, b) => (b.at > a.at ? b : a)) : null;
    return {
      restartsInWindow: lastError ? null : recent.length,
      lastRestartAt: last ? new Date(last.at).toISOString() : null,
      lastRestartReason: last ? last.reason : null,
      stateFileError: lastError,
    };
  }

  return { load, tryAcquire, snapshot, file, lockFile, maxInWindow, windowMs };
}
