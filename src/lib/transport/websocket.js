/**
 * WebSocket long connection transport for Lark/Feishu
 *
 * Uses SDK's WSClient with EventDispatcher for persistent event subscription.
 * Exactly ONE WSClient is created per process; it is never replaced in-process.
 *
 * SDK issue node-sdk#177 (timer leak in reConnect):
 * - reconnectCount is NOT a valid WSClient constructor param (server-controlled)
 * - Mitigation: rely on autoReconnect only, never call reConnect externally
 * - PM2 kill_timeout + max_restarts handles persistent failures
 *
 * Half-open connection watchdog (pong timeout) -> controlled process restart:
 * The SDK's pingLoop sends a ping every `pingInterval` (server-provided,
 * currently 120s) and, on pong, only refreshes wsConfig — it never times out.
 * A half-open socket (stays OPEN, no close/error, no inbound frames) is
 * therefore never detected and the SDK's autoReconnect never fires. We track
 * pong receipt ourselves. When a pong HAS been observed in this process and
 * then none arrives within `ws_pong_timeout_sec` (default 3 x pingInterval),
 * the transport logs an ERROR, closes the WSClient best-effort, runs the
 * host's graceful shutdown hook and exits with RESTART_EXIT_CODE so PM2
 * (autorestart) starts a fresh process. A hard deadline (RESTART_DEADLINE_MS)
 * guarantees the exit even if cleanup hangs.
 *
 * Why a process restart instead of swapping WSClients in-process: SDK 1.59.0
 * cannot be reliably destroyed. close() does not cancel a reConnect()/
 * loopReConnect closure already awaiting pullConnectConfig() (it goes on to
 * connect() and schedule further reconnects), and every WSClient constructs
 * a DataCache whose 10s setInterval has no handle and is never cleared.
 * Process exit is the only complete cleanup.
 *
 * Anti-loop safeguards:
 * - No pong ever observed in this process -> never restart (detection may be
 *   broken after an SDK upgrade); a one-time WARN is logged instead.
 * - Cross-process rate limit (restart-guard.js): at most
 *   RESTART_MAX_IN_WINDOW (3) restarts per RESTART_WINDOW_MS (30 min),
 *   persisted in ~/zylos/components/lark/ws-restart-state.json, serialized
 *   by an exclusive lock file (async acquisition, never blocks the loop).
 *   When the limit is hit, or the state file is corrupt/unwritable, the
 *   restart is suppressed with one ERROR and the watchdog keeps monitoring;
 *   if the lock cannot be taken the attempt is deferred (distinct log line).
 * - An exit only happens >= one full pong timeout (>= 30s, 360s by default)
 *   after the last pong, so PM2 never counts it as an unstable restart
 *   (min_uptime default 1s; max_restarts only applies to unstable restarts).
 *
 * Pong detection — SDK-version coupling (verified against
 * @larksuiteoapi/node-sdk 1.59.0, lib/index.js `class WSClient`):
 * - WSClient.communicate() dispatches every decoded control frame through
 *   `this.handleControlData(frame)` (dynamic `this.` lookup), so wrapping the
 *   method on the *instance* sees every pong. A pong frame has a header
 *   `{ key: 'type', value: 'pong' }` (HeaderKey.type / MessageType.pong).
 *   The wrapper always delegates to the original handler.
 * - This was chosen over (a) parsing the SDK's `'receive pong'` trace log text
 *   (log strings are the least stable surface and would force loggerLevel
 *   trace) and (c) a second raw 'message' listener (would need the SDK's
 *   private protobuf decoder).
 * - The ping interval is read from `wsClient.wsConfig.getWS('pingInterval')`
 *   (ms); falls back to 120s if that internal is missing.
 * - If a future SDK renames these internals, detection degrades safely: no
 *   pong is ever seen, so the watchdog never restarts, and a startup
 *   self-check WARNs after 2 intervals. Re-verify on every SDK upgrade.
 */

import path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { DATA_DIR } from '../config.js';
import { createRestartGuard, RESTART_STATE_FILENAME, RESTART_MAX_IN_WINDOW, RESTART_WINDOW_MS } from './restart-guard.js';

export { RESTART_MAX_IN_WINDOW, RESTART_WINDOW_MS, RESTART_STATE_FILENAME };

const DOMAIN_MAP = {
  feishu: lark.Domain.Feishu,
  lark: lark.Domain.Lark,
};

export const DEFAULT_PING_INTERVAL_MS = 120_000;
export const PONG_TIMEOUT_MULTIPLIER = 3;
/** Extra slack on top of one interval before a pong counts as "late". */
export const LATE_GRACE_MS = 30_000;
export const WATCHDOG_TICK_MS = 10_000;
export const SUMMARY_INTERVAL_MS = 30 * 60_000;
/** Lower bound for a configured ws_pong_timeout_sec. */
export const MIN_PONG_TIMEOUT_SEC = 30;
/**
 * Hard deadline from restart request to exit. Below PM2 kill_timeout (5000ms)
 * so a hung close/cleanup can never keep a deaf process alive.
 */
export const RESTART_DEADLINE_MS = 4_000;
/** Exit code for a watchdog restart (EX_TEMPFAIL). Any non-zero code makes PM2 restart. */
export const RESTART_EXIT_CODE = 75;

const WS_OPEN = 1;

function sec(ms) {
  return Math.round(ms / 1000);
}

function isPongFrame(frame) {
  const headers = frame?.headers;
  if (!Array.isArray(headers)) return false;
  return headers.some((h) => h?.key === 'type' && h?.value === 'pong');
}

/**
 * Parse `ws_pong_timeout_sec` from config.
 * @returns {{ mode: 'auto' } | { mode: 'fixed', ms: number } | { mode: 'disabled' }}
 */
export function parsePongTimeout(value, log = console) {
  if (value === undefined || value === null || value === '') return { mode: 'auto' };
  const n = Number(value);
  if (n === 0) return { mode: 'disabled' };
  if (!Number.isFinite(n) || n < MIN_PONG_TIMEOUT_SEC) {
    log.warn(`[lark] invalid ws_pong_timeout_sec=${JSON.stringify(value)} (must be 0 or >= ${MIN_PONG_TIMEOUT_SEC}); using default ${PONG_TIMEOUT_MULTIPLIER} x ping interval`);
    return { mode: 'auto' };
  }
  return { mode: 'fixed', ms: Math.round(n * 1000) };
}

/**
 * Create a WebSocket transport instance. Dependencies are injectable for tests.
 *
 * @param {object} [deps]
 * @param {function} [deps.exit] - process exit (default process.exit)
 * @param {string} [deps.stateFile] - restart rate-limit state file
 * @param {object} [deps.fs] - fs for the state file (tests)
 * @param {number} [deps.watchdogTickMs] - tick period (tests)
 */
export function createWebSocketTransport(deps = {}) {
  const {
    WSClient = lark.WSClient,
    EventDispatcher = lark.EventDispatcher,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    log = console,
    exit = (code) => process.exit(code),
    stateFile = path.join(DATA_DIR, RESTART_STATE_FILENAME),
    fs,
    watchdogTickMs = WATCHDOG_TICK_MS,
  } = deps;

  const guard = createRestartGuard({ file: stateFile, fs, now });

  let wsClient = null;
  let clientCreated = false;
  let eventDispatcher = null;
  let pongTimeout = { mode: 'auto' };
  let onShutdown = null;
  let stopped = false;

  let watchdogTimer = null;
  let summaryTimer = null;
  let deadlineTimer = null;

  const state = {
    connected: false,
    connectedSince: null,
    clientStartedAt: null,
    lastPongAt: null,
    pongCount: 0,
    pongsSinceSummary: 0,
    everSeenPong: false,
    lateWarned: false,
    selfCheckWarned: false,
    /** Current suppression episode: { cause, detail, retryAt } | null */
    suppression: null,
    restartPending: false,
    acquiring: false,
    exited: false,
  };

  function unref(t) {
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  }

  function getPingIntervalMs() {
    try {
      const v = wsClient?.wsConfig?.getWS?.('pingInterval');
      if (Number.isFinite(v) && v > 0) return v;
    } catch { /* fall through */ }
    return DEFAULT_PING_INTERVAL_MS;
  }

  function getTimeoutMs(intervalMs = getPingIntervalMs()) {
    if (pongTimeout.mode === 'fixed') return pongTimeout.ms;
    return intervalMs * PONG_TIMEOUT_MULTIPLIER;
  }

  function socketState() {
    try {
      const ws = wsClient?.wsConfig?.getWSInstance?.();
      if (!ws) return 'none';
      return ws.readyState === WS_OPEN ? 'open' : `state-${ws.readyState}`;
    } catch {
      return 'unknown';
    }
  }

  function onPong() {
    if (stopped || state.restartPending) return;
    const t = now();
    const wasLate = state.lateWarned;
    const prevAge = state.lastPongAt ? t - state.lastPongAt : null;
    state.lastPongAt = t;
    state.pongCount++;
    state.pongsSinceSummary++;
    state.lateWarned = false;
    if (state.suppression) {
      log.log('[lark] ws pong recovered while process restart was suppressed; watchdog re-armed');
      state.suppression = null;
    }
    if (!state.everSeenPong) {
      state.everSeenPong = true;
      if (state.selfCheckWarned) {
        log.log('[lark] ws pong detection working (first pong observed)');
      }
    }
    if (wasLate) {
      log.log(`[lark] ws pong recovered: previous pong ${sec(prevAge)}s ago`);
    }
  }

  function instrument(client) {
    const orig = client?.handleControlData;
    if (typeof orig !== 'function') {
      log.warn('[lark] ws pong detection unavailable: WSClient.handleControlData not found (SDK internals changed?) — half-open watchdog cannot restart the process');
      return;
    }
    client.handleControlData = function patchedHandleControlData(frame, ...rest) {
      try {
        if (isPongFrame(frame)) onPong();
      } catch { /* never break SDK control handling */ }
      return orig.call(this, frame, ...rest);
    };
  }

  function clearTimers() {
    if (watchdogTimer) { clearIntervalFn(watchdogTimer); watchdogTimer = null; }
    if (summaryTimer) { clearIntervalFn(summaryTimer); summaryTimer = null; }
  }

  /** Best-effort synchronous close of the (only) WSClient. */
  function closeClient() {
    const client = wsClient;
    wsClient = null;
    state.connected = false;
    if (!client) return false;
    try {
      client.close({ force: true });
    } catch (err) {
      log.warn(`[lark] WS close error: ${err.message}`);
    }
    return true;
  }

  function finishRestart(why) {
    if (state.exited) return;
    state.exited = true;
    if (deadlineTimer) { clearTimeoutFn(deadlineTimer); deadlineTimer = null; }
    if (why === 'deadline') {
      log.error(`[lark] ws restart: graceful shutdown exceeded ${sec(RESTART_DEADLINE_MS)}s deadline; exiting now`);
    }
    log.error(`[lark] ws restart: exiting with code ${RESTART_EXIT_CODE} so PM2 restarts the process`);
    exit(RESTART_EXIT_CODE);
  }

  /**
   * Controlled restart: close the WSClient, run the host's graceful shutdown
   * hook, exit non-zero. The deadline timer is deliberately NOT unref'd: it
   * must fire even if everything else has gone quiet.
   */
  function requestRestart(reason) {
    if (state.restartPending) return;
    state.restartPending = true;
    clearTimers();
    deadlineTimer = setTimeoutFn(() => finishRestart('deadline'), RESTART_DEADLINE_MS);
    closeClient();
    Promise.resolve()
      .then(() => (onShutdown ? onShutdown({ reason }) : undefined))
      .catch((err) => log.error(`[lark] ws restart: graceful shutdown error: ${err?.message || err}`))
      .finally(() => finishRestart('graceful'));
  }

  function tick() {
    if (stopped || state.restartPending || !wsClient || !state.clientStartedAt) return;
    const intervalMs = getPingIntervalMs();
    const timeoutMs = getTimeoutMs(intervalMs);
    const sinceStart = now() - state.clientStartedAt;

    if (!state.everSeenPong) {
      // Self-check: detection may be broken (e.g. SDK upgrade renamed
      // internals). Never restart without having seen a pong (no boot loop).
      if (!state.selfCheckWarned && sinceStart > 2 * intervalMs) {
        state.selfCheckWarned = true;
        log.warn(`[lark] ws no pong observed ${sec(sinceStart)}s after connect (interval ${sec(intervalMs)}s) — pong detection may be broken (SDK internals changed?); half-open watchdog will not restart the process until a pong is seen`);
      }
      return;
    }

    const age = now() - state.lastPongAt;
    if (!state.lateWarned && age > intervalMs + LATE_GRACE_MS) {
      state.lateWarned = true;
      log.warn(`[lark] ws pong late: last pong ${sec(age)}s ago (interval ${sec(intervalMs)}s)`);
    }

    if (pongTimeout.mode === 'disabled' || age <= timeoutMs) return;
    if (state.suppression && now() < state.suppression.retryAt) return;

    if (state.acquiring) return;
    const head = `[lark] ws half-open detected: no pong for ${sec(age)}s (timeout ${sec(timeoutMs)}s, socket=${socketState()})`;
    state.acquiring = true;
    // Async: the guard waits for a cross-process lock without blocking the loop.
    Promise.resolve()
      .then(() => guard.tryAcquire('pong-timeout'))
      .then((verdict) => onVerdict(head, verdict))
      .catch((err) => log.error(`[lark] ws restart guard error: ${err?.message || err}`))
      .finally(() => { state.acquiring = false; });
  }

  function onVerdict(head, verdict) {
    if (stopped || state.restartPending) return;
    if (!verdict.allowed) {
      const first = !state.suppression || state.suppression.cause !== verdict.cause;
      state.suppression = { cause: verdict.cause, detail: verdict.detail, retryAt: verdict.retryAt };
      if (!first) return;
      if (verdict.cause === 'lock-unavailable' || verdict.cause === 'guard-error') {
        // Contention / lock failure is NOT state-file corruption: only this
        // attempt is skipped; the watchdog keeps monitoring and retries.
        log.error(`${head} -> process restart DEFERRED (${verdict.cause}: ${verdict.detail}); this attempt skipped, monitoring continues, retry at ${new Date(verdict.retryAt).toISOString()}`);
      } else {
        log.error(`${head} -> process restart SUPPRESSED (${verdict.cause}: ${verdict.detail}; state file ${guard.file}); monitoring only, next check at ${new Date(verdict.retryAt).toISOString()}`);
      }
      return;
    }
    state.suppression = null;
    log.error(`${head} -> requesting controlled process restart (restart ${verdict.restartsInWindow}/${guard.maxInWindow} in ${sec(guard.windowMs) / 60}m window)`);
    requestRestart('pong-timeout');
  }

  function summary() {
    if (stopped) return;
    const k = state.pongsSinceSummary;
    state.pongsSinceSummary = 0;
    if (!state.lastPongAt) {
      log.log(`[lark] ws heartbeat: no pong observed yet (${k} pongs in 30m)`);
      return;
    }
    const age = now() - state.lastPongAt;
    const status = age > getPingIntervalMs() + LATE_GRACE_MS ? 'degraded' : 'ok';
    log.log(`[lark] ws heartbeat ${status}: last pong ${sec(age)}s ago, ${k} pongs in 30m`);
  }

  function startTimers() {
    if (!watchdogTimer) watchdogTimer = unref(setIntervalFn(tick, watchdogTickMs));
    if (!summaryTimer) summaryTimer = unref(setIntervalFn(summary, SUMMARY_INTERVAL_MS));
  }

  function logPreviousRestarts() {
    const loaded = guard.load();
    if (!loaded.ok) {
      log.error(`[lark] ws restart state file ${guard.file} is ${loaded.error}; watchdog restarts will be refused until it is reset (automatic on next half-open detection)`);
      return;
    }
    const snap = guard.snapshot();
    if (snap.lastRestartAt && snap.restartsInWindow > 0) {
      log.log(`[lark] ws previous watchdog restart at ${snap.lastRestartAt} (reason=${snap.lastRestartReason}); ${snap.restartsInWindow}/${guard.maxInWindow} restarts in last ${sec(guard.windowMs) / 60}m`);
    }
  }

  /**
   * Start WebSocket transport.
   * @param {object} config - from getConfig()
   * @param {object} credentials - { app_id, app_secret }
   * @param {function} handleMessageEvent - the message handler from index.js
   * @param {function} isDuplicate - dedup check function from index.js
   * @param {object} [hooks]
   * @param {function} [hooks.onShutdown] - async graceful cleanup run before a
   *   watchdog restart exit (close HTTP server, persist caches, flush logs)
   */
  async function start(config, credentials, handleMessageEvent, isDuplicate, hooks = {}) {
    if (clientCreated) throw new Error('WebSocket transport already started (one WSClient per process)');
    clientCreated = true;
    stopped = false;
    onShutdown = typeof hooks.onShutdown === 'function' ? hooks.onShutdown : null;
    pongTimeout = parsePongTimeout(config?.ws_pong_timeout_sec, log);
    logPreviousRestarts();

    eventDispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        // SDK EventDispatcher flattens header + event fields into data top level.
        // data.message, data.sender, data.create_time are all at top level.
        const messageId = data.message?.message_id;
        if (isDuplicate(messageId)) return;

        // Wrap into the same shape as webhook events so handleMessageEvent works unchanged
        const event = {
          event: { message: data.message, sender: data.sender },
          header: { create_time: data.create_time || null },
        };
        try {
          await handleMessageEvent(event);
        } catch (err) {
          console.error(`[lark] WS pipeline error: ${err.message}`);
        }
      },
    });

    const domain = DOMAIN_MAP[config?.domain] || lark.Domain.Lark;
    const client = new WSClient({
      appId: credentials.app_id,
      appSecret: credentials.app_secret,
      domain,
      loggerLevel: lark.LoggerLevel.info,
      autoReconnect: true,
    });
    instrument(client);
    wsClient = client;
    state.clientStartedAt = now();
    startTimers();
    await client.start({ eventDispatcher });
    if (stopped) return;
    state.connected = true;
    state.connectedSince = new Date(now()).toISOString();
    const timeoutDesc = pongTimeout.mode === 'disabled'
      ? 'disabled (monitoring only)'
      : pongTimeout.mode === 'fixed' ? `${sec(pongTimeout.ms)}s` : `${PONG_TIMEOUT_MULTIPLIER} x ping interval`;
    log.log(`[lark] WebSocket client started (pong timeout: ${timeoutDesc})`);
  }

  /** Stop WebSocket transport. Call this during shutdown. Idempotent. */
  function stop() {
    stopped = true;
    clearTimers();
    if (closeClient()) log.log('[lark] WebSocket client stopped');
  }

  /** Current connection state for /health endpoint. */
  function getState() {
    const age = state.lastPongAt ? now() - state.lastPongAt : null;
    const snap = guard.snapshot();
    return {
      connected: state.connected,
      connectedSince: state.connectedSince,
      lastPongAt: state.lastPongAt ? new Date(state.lastPongAt).toISOString() : null,
      lastPongAgeSec: age == null ? null : sec(age),
      pongCount: state.pongCount,
      restartPending: state.restartPending,
      restartSuppressed: !!state.suppression,
      restartSuppressedReason: state.suppression ? state.suppression.cause : null,
      restartsInWindow: snap.restartsInWindow,
      lastRestartAt: snap.lastRestartAt,
      lastRestartReason: snap.lastRestartReason,
    };
  }

  return {
    start,
    stop,
    getConnectionState: getState,
    // exposed for tests
    _tick: tick,
    _summary: summary,
    _getClient: () => wsClient,
  };
}

const defaultTransport = createWebSocketTransport();

export function startWebSocket(config, credentials, handleMessageEvent, isDuplicate, hooks) {
  return defaultTransport.start(config, credentials, handleMessageEvent, isDuplicate, hooks);
}

export function stopWebSocket() {
  defaultTransport.stop();
}

export function getConnectionState() {
  return defaultTransport.getConnectionState();
}
