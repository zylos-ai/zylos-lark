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
 *   Lock and ledger bodies are written completely (writeAllSync loops over
 *   short writes; zero progress or an error fails closed).
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
 * - Release in `finally` on every path, and only if the lock file still
 *   carries our token — a newer holder's lock is never removed.
 * - Fail-closed: lock timeout or any lock error -> this restart attempt is
 *   refused with cause 'lock-unavailable' (distinct from 'corrupt'); the
 *   caller keeps monitoring and retries later. Nothing proceeds without the
 *   lock.
 * - NO automatic stale-lock takeover. zylos-lark runs as a single PM2
 *   instance, so real contention is essentially nil, and every auto-break
 *   scheme (rename-then-verify, link restore) opened worse failure modes
 *   (two holders in the critical section). A lock left behind by a crash
 *   (empty file if the crash hit between create and write, or a dead /
 *   reused pid) therefore blocks watchdog restarts until an operator removes
 *   it. inspectLock() classifies the holder FOR REPORTING ONLY
 *   (held-by-self | held-by-live-pid | held-by-dead-pid | unknown-owner |
 *   path-error) so logs and
 *   /health can show the lock path, owner pid, age and a recovery hint.
 *   Path-level problems (data dir missing / not a directory / not
 *   accessible) are reported as 'path-error' with a path-specific hint —
 *   never as a lock to delete.
 * - If writing our lock content fails right after the O_EXCL create, the
 *   lock is NOT unlinked by path (the pathname may already belong to someone
 *   else); the attempt fails closed and the leftover is reported like any
 *   other blocking lock.
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
export const LOCK_RETRY_MIN_MS = 5;
export const LOCK_RETRY_MAX_MS = 25;
/** After a lock-unavailable refusal, re-evaluate this much later. */
export const LOCK_RETRY_AFTER_MS = 60_000;

/**
 * Classify a lock owner pid. REPORTING ONLY — never used to break a lock.
 * @returns {'held-by-live-pid'|'held-by-dead-pid'|'unknown-owner'}
 */
export function classifyLockOwner(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown-owner';
  try {
    process.kill(pid, 0);
    return 'held-by-live-pid';
  } catch (err) {
    if (err?.code === 'EPERM') return 'held-by-live-pid';
    if (err?.code === 'ESRCH') return 'held-by-dead-pid';
    return 'unknown-owner';
  }
}

/**
 * Actionable, error-specific manual recovery instruction for a lock
 * observation (from inspectLock). Returns null when the lock is free.
 * Only an actually observed lock entry gets the (ownership-safe) delete
 * advice; path-level problems get path fixes. Never an unconditional rm.
 * Keep in sync with DESIGN.md §5.2.1.
 */
export function lockRecoveryHint(obs) {
  if (!obs || obs.lockState === 'free') return null;
  const dir = path.dirname(obs.lockPath);
  const code = obs.lockError;
  if (obs.lockState === 'path-error') {
    if (code === 'ENOTDIR') {
      return `the data directory path is invalid (${dir} or one of its parents is not a directory); fix or recreate the component data dir ${dir}, no lock file exists to remove`;
    }
    if (code === 'ENOENT-parent') {
      return `the data directory ${dir} does not exist; recreate the component data dir (owned by the zylos-lark user), no lock file exists to remove`;
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return `restore access to ${dir} for the zylos-lark user (read + search, and write for restarts), then re-check`;
    }
    return `cannot inspect ${obs.lockPath} (${code}); check the component data dir ${dir}`;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `restore read access to ${obs.lockPath} for the zylos-lark user, then re-check`;
  }
  if (obs.lockState === 'held-by-self' || obs.lockState === 'held-by-live-pid') {
    // The holder may be a running zylos-lark (for held-by-self: this very
    // process), so the lock can only be removed with the service stopped.
    const who = obs.lockState === 'held-by-self' ? 'this zylos-lark process holds it' : 'the holder may be a running zylos-lark';
    return `${who}: run \`pm2 stop zylos-lark\`, confirm \`ps -p ${obs.lockOwnerPid}\` no longer shows that pid and \`pm2 ls\` shows no running zylos-lark, then remove ${obs.lockPath}, then \`pm2 start zylos-lark\``;
  }
  const pidCheck = obs.lockOwnerPid
    ? `\`ps -p ${obs.lockOwnerPid}\` shows that pid is not a running zylos-lark process`
    : 'the lock names no valid owner pid';
  return `verify the holder first: ${pidCheck} and \`pm2 ls\` shows no second zylos-lark instance; only then remove ${obs.lockPath} manually to re-enable watchdog restarts`;
}

/**
 * Write the whole buffer to fd, looping over short writes. A zero-progress
 * write or any error throws, so callers fail closed.
 */
export function writeAllSync(fs, fd, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (!Number.isInteger(n) || n <= 0) {
      const e = new Error(`short write: ${off}/${buf.length} bytes written, no progress`);
      e.code = 'ESHORTWRITE';
      throw e;
    }
    off += n;
  }
  return off;
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
 */
export function createRestartGuard({
  file,
  fs = nodeFs,
  now = () => Date.now(),
  maxInWindow = RESTART_MAX_IN_WINDOW,
  windowMs = RESTART_WINDOW_MS,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
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
  /** Tokens minted by this process (to recognise a lock we left behind). */
  const mintedTokens = new Set();
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
    let created = false;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600); // unique name, and proof we created it
      created = true;
      writeAllSync(fs, fd, body);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, file);
    } catch (err) {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      // Only our own temp file (never renamed into place on failure).
      if (created) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
      throw err;
    }
    cached = restarts;
  }

  /**
   * Best-effort description of the current lock holder. REPORTING ONLY.
   * @returns {{ lockPath: string, lockState: 'free'|'held-by-self'|'held-by-live-pid'|'held-by-dead-pid'|'unknown-owner'|'path-error', lockOwnerPid: number|null, lockAgeSec: number|null, lockError: string|null }}
   */
  function inspectLock() {
    const res = { lockPath: lockFile, lockState: 'free', lockOwnerPid: null, lockAgeSec: null, lockError: null };
    const pathError = (code) => ({ ...res, lockState: 'path-error', lockError: code || 'stat-error' });
    let st;
    try {
      st = fs.lstatSync(lockFile);
    } catch (err) {
      if (err?.code !== 'ENOENT') return pathError(err?.code); // ENOTDIR, EACCES, ...
      // Absent. Is that because the data dir itself is missing / not a dir?
      try {
        if (!fs.statSync(path.dirname(lockFile)).isDirectory()) return pathError('ENOTDIR');
      } catch (e2) {
        return pathError(e2?.code === 'ENOENT' ? 'ENOENT-parent' : e2?.code);
      }
      return res; // truly free
    }
    // A lock entry was observed.
    res.lockAgeSec = Math.max(0, Math.round((Date.now() - st.mtimeMs) / 1000));
    let raw;
    try {
      raw = fs.readFileSync(lockFile, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') { // released between lstat and read
        return { ...res, lockAgeSec: null, lockError: 'ENOENT-during-read' };
      }
      return { ...res, lockState: 'unknown-owner', lockError: err?.code || 'read-error' };
    }
    let info = null;
    try { info = JSON.parse(raw); } catch { /* empty / partial */ }
    const pid = info && typeof info === 'object' ? info.pid : undefined;
    res.lockOwnerPid = Number.isInteger(pid) && pid > 0 ? pid : null;
    res.lockState = classifyLockOwner(pid);
    // Our own pid AND a token we minted -> left behind by this process (e.g.
    // fsync/close failed after the content was written). Our pid with a
    // foreign token stays held-by-live-pid (pid in use, lock not ours).
    if (pid === process.pid && mintedTokens.has(info?.token)) res.lockState = 'held-by-self';
    if (!info) res.lockError = raw.length ? 'unparseable' : 'empty';
    return res;
  }

  /** Acquire the exclusive lock or throw (fail-closed). Resolves to our token. */
  async function acquireLock() {
    const token = `${process.pid}.${Date.now()}.${++lockSeq}.${Math.random().toString(36).slice(2)}`;
    mintedTokens.add(token);
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
          writeAllSync(fs, fd, body); // a truncated lock would be unreleasable
          fs.fsyncSync(fd);
          fs.closeSync(fd);
        } catch (err) {
          // Fail closed WITHOUT unlinking by path: the pathname may no longer
          // be the file we created (replaced by another process), and an
          // fd-vs-path identity check is not robust against every race. The
          // partial lock stays and is reported (held-by-self, or
          // unknown-owner / empty) with the manual recovery surface. Even a
          // held-by-self lock is never auto-deleted (path-replacement TOCTOU).
          try { fs.closeSync(fd); } catch { /* ignore */ }
          err.lockInitFailed = true;
          throw err;
        }
        return token;
      }
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
    const lockUnavailable = (err) => {
      const lock = inspectLock();
      const owner = lock.lockState === 'free'
        ? ''
        : ` (${lock.lockState}, pid ${lock.lockOwnerPid ?? 'unknown'}, age ${lock.lockAgeSec ?? '?'}s)`;
      return {
        allowed: false,
        cause: 'lock-unavailable',
        detail: `cannot lock restart state: ${err?.code === 'ELOCKTIMEOUT' ? err.message : err?.code || err?.message || 'error'}${owner}`,
        retryAt: now() + LOCK_RETRY_AFTER_MS,
        restartsInWindow: null,
        lock,
      };
    };
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

  return { load, tryAcquire, snapshot, inspectLock, file, lockFile, maxInWindow, windowMs };
}
