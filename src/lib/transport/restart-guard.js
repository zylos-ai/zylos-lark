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
 */

import nodeFs from 'node:fs';
import path from 'node:path';

export const RESTART_STATE_FILENAME = 'ws-restart-state.json';
/** Max watchdog restarts allowed inside one window. */
export const RESTART_MAX_IN_WINDOW = 3;
/** Sliding window for RESTART_MAX_IN_WINDOW. */
export const RESTART_WINDOW_MS = 30 * 60_000;
export const CORRUPT_REASON = 'state-file-corrupt';

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
 */
export function createRestartGuard({
  file,
  fs = nodeFs,
  now = () => Date.now(),
  maxInWindow = RESTART_MAX_IN_WINDOW,
  windowMs = RESTART_WINDOW_MS,
} = {}) {
  if (!file) throw new Error('restart guard: state file path required');
  let tmpSeq = 0;
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
    cached = parsed.restarts.map((r) => ({ at: r.at, reason: typeof r.reason === 'string' ? r.reason : 'unknown' }));
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

  function inWindow(restarts, t = now()) {
    return restarts.filter((r) => t - r.at < windowMs).sort((a, b) => a.at - b.at);
  }

  /**
   * Decide whether a restart may happen now and, if so, persist its record.
   * @returns {{ allowed: true, restartsInWindow: number }
   *   | { allowed: false, cause: 'rate-limited'|'corrupt'|'write-failed', detail: string, retryAt: number, restartsInWindow: number|null }}
   */
  function tryAcquire(reason) {
    const t = now();
    const loaded = load();
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
    try {
      write([...recent, { at: t, reason }]);
    } catch (err) {
      return {
        allowed: false,
        cause: 'write-failed',
        detail: `cannot persist restart record (${err?.code || err?.message || 'error'})`,
        retryAt: t + windowMs,
        restartsInWindow: recent.length,
      };
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

  return { load, tryAcquire, snapshot, file, maxInWindow, windowMs };
}
