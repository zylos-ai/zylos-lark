/**
 * WebSocket long connection transport for Lark/Feishu
 *
 * Uses SDK's WSClient with EventDispatcher for persistent event subscription.
 *
 * SDK issue node-sdk#177 (timer leak in reConnect):
 * - reconnectCount is NOT a valid WSClient constructor param (server-controlled)
 * - Mitigation: rely on autoReconnect only, never call reConnect externally
 * - PM2 kill_timeout + max_restarts handles persistent failures
 *
 * Half-open connection watchdog (pong timeout):
 * The SDK's pingLoop sends a ping every `pingInterval` (server-provided,
 * currently 120s) and, on pong, only refreshes wsConfig — it never times out.
 * A half-open socket (stays OPEN, no close/error, no inbound frames) is
 * therefore never detected and the SDK's autoReconnect never fires. We track
 * pong receipt ourselves and, when no pong arrives within `ws_pong_timeout_sec`
 * (default 3 x pingInterval), close the WSClient and build a fresh one
 * (never via the SDK's reConnect(), see #177 above).
 *
 * Pong detection — SDK-version coupling (verified against
 * @larksuiteoapi/node-sdk 1.59.0, lib/index.js `class WSClient`):
 * - WSClient.communicate() dispatches every decoded control frame through
 *   `this.handleControlData(frame)` (dynamic `this.` lookup), so wrapping the
 *   method on the *instance* sees every pong. A pong frame has a header
 *   `{ key: 'type', value: 'pong' }` (HeaderKey.type / MessageType.pong).
 * - This was chosen over (a) parsing the SDK's `'receive pong'` trace log text
 *   (log strings are the least stable surface and would force loggerLevel
 *   trace) and (c) a second raw 'message' listener (would need the SDK's
 *   private protobuf decoder).
 * - The ping interval is read from `wsClient.wsConfig.getWS('pingInterval')`
 *   (ms); falls back to 120s if that internal is missing.
 * - If a future SDK renames these internals, detection degrades safely: a
 *   startup self-check logs a WARN when no pong has been seen within
 *   2 intervals, and pong-timeout reconnects are capped while no pong has
 *   ever been observed in this process (so broken detection cannot cause a
 *   reconnect loop). Re-verify these internals on every SDK upgrade.
 */

import * as lark from '@larksuiteoapi/node-sdk';

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
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 60_000;
/** How long a fresh WSClient may take to reach an OPEN socket. */
export const CONNECT_TIMEOUT_MS = 30_000;
export const CONNECT_POLL_MS = 500;
/** Pong-timeout reconnects allowed while no pong was ever observed. */
export const MAX_BLIND_RECONNECTS = 1;
/** Lower bound for a configured ws_pong_timeout_sec. */
export const MIN_PONG_TIMEOUT_SEC = 30;

const WS_OPEN = 1;

function sec(ms) {
  return Math.round(ms / 1000);
}

function isPongFrame(frame) {
  const headers = frame?.headers;
  if (!Array.isArray(headers)) return false;
  return headers.some((h) => h?.key === 'type' && h?.value === 'pong');
}

function formatDuration(ms) {
  if (ms == null || ms < 0) return 'unknown';
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
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
 * Make a retired WSClient inert. close() clears the SDK's current timers, but
 * a reConnect()/connect() already in flight (node-sdk#177) could still open a
 * socket afterwards; neutering the instance methods prevents the old client
 * from pinging, reconnecting or adopting a new socket into stale state.
 */
function retireClient(client, log) {
  if (!client) return;
  try {
    client.close({ force: true });
  } catch (err) {
    log.warn(`[lark] WS close error: ${err.message}`);
  }
  try {
    client.reConnect = async () => {};
    client.connect = async () => false;
    client.pingLoop = () => {};
    client.communicate = () => {};
    if (client.wsConfig && typeof client.wsConfig.setWSInstance === 'function') {
      client.wsConfig.setWSInstance = (ws) => {
        try { ws?.removeAllListeners?.(); ws?.terminate?.(); } catch { /* ignore */ }
      };
    }
  } catch { /* best effort */ }
}

/**
 * Create a WebSocket transport instance. Dependencies are injectable for tests.
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
  } = deps;

  let wsClient = null;
  let clientGen = 0;
  let eventDispatcher = null;
  let startArgs = null;
  let pongTimeout = { mode: 'auto' };
  let stopped = false;

  let watchdogTimer = null;
  let summaryTimer = null;
  let backoffTimer = null;
  let backoffResolve = null;

  const state = {
    connected: false,
    connectedSince: null,
    connectedSinceMs: null,
    clientStartedAt: null,
    lastPongAt: null,
    pongCount: 0,
    pongsSinceSummary: 0,
    everSeenPong: false,
    lateWarned: false,
    selfCheckWarned: false,
    blindReconnects: 0,
    blindSuppressedWarned: false,
    reconnecting: false,
    reconnects: 0,
    lastReconnectReason: null,
    lastReconnectAt: null,
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

  /** Age of the freshest liveness signal for the current client. */
  function pongAgeMs() {
    const ref = Math.max(state.lastPongAt ?? 0, state.clientStartedAt ?? 0);
    return ref ? now() - ref : null;
  }

  function onPong(gen) {
    if (gen !== clientGen || stopped) return; // stale client
    const t = now();
    const wasLate = state.lateWarned;
    const prevAge = state.lastPongAt ? t - state.lastPongAt : null;
    state.lastPongAt = t;
    state.pongCount++;
    state.pongsSinceSummary++;
    state.lateWarned = false;
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

  function instrument(client, gen) {
    const orig = client?.handleControlData;
    if (typeof orig !== 'function') {
      log.warn('[lark] ws pong detection unavailable: WSClient.handleControlData not found (SDK internals changed?) — half-open watchdog degraded');
      return;
    }
    client.handleControlData = function patchedHandleControlData(frame, ...rest) {
      try {
        if (isPongFrame(frame)) onPong(gen);
      } catch { /* never break SDK control handling */ }
      return orig.call(this, frame, ...rest);
    };
  }

  async function waitForOpen(client) {
    const cfg = client?.wsConfig;
    if (!cfg || typeof cfg.getWSInstance !== 'function') return; // cannot verify; trust start()
    const deadline = now() + CONNECT_TIMEOUT_MS;
    while (!stopped) {
      if (cfg.getWSInstance()?.readyState === WS_OPEN) return;
      if (now() >= deadline) throw new Error(`no open socket within ${sec(CONNECT_TIMEOUT_MS)}s`);
      await new Promise((resolve) => unref(setTimeoutFn(resolve, CONNECT_POLL_MS)));
    }
  }

  /** Build, instrument and start a fresh WSClient. */
  async function openClient({ waitOpen }) {
    const { config, credentials } = startArgs;
    const domain = DOMAIN_MAP[config.domain] || lark.Domain.Lark;
    const gen = ++clientGen;
    const client = new WSClient({
      appId: credentials.app_id,
      appSecret: credentials.app_secret,
      domain,
      loggerLevel: lark.LoggerLevel.info,
      autoReconnect: true,
    });
    instrument(client, gen);
    wsClient = client;
    state.clientStartedAt = now();
    try {
      await client.start({ eventDispatcher });
      if (waitOpen) await waitForOpen(client);
    } catch (err) {
      if (wsClient === client) {
        retireClient(client, log);
        wsClient = null;
        clientGen++;
      }
      throw err;
    }
    if (stopped) {
      retireClient(client, log);
      throw new Error('transport stopped');
    }
    state.connected = true;
    state.connectedSinceMs = now();
    state.connectedSince = new Date(state.connectedSinceMs).toISOString();
    return client;
  }

  function sleepBackoff(ms) {
    return new Promise((resolve) => {
      backoffResolve = resolve;
      backoffTimer = unref(setTimeoutFn(() => {
        backoffTimer = null;
        backoffResolve = null;
        resolve();
      }, ms));
    });
  }

  async function reconnect(reason) {
    if (state.reconnecting || stopped) return false; // single-flight
    state.reconnecting = true;
    const t0 = now();
    const prevSinceMs = state.connectedSinceMs;
    const old = wsClient;
    wsClient = null;
    clientGen++; // any late pong from the old client is ignored from here on
    state.connected = false;
    retireClient(old, log);

    let attempt = 0;
    try {
      while (!stopped) {
        attempt++;
        try {
          await openClient({ waitOpen: true });
          state.reconnects++;
          state.lastReconnectReason = reason;
          state.lastReconnectAt = new Date(now()).toISOString();
          state.lateWarned = false;
          const prevUp = prevSinceMs ? formatDuration(t0 - prevSinceMs) : 'unknown';
          log.log(`[lark] ws reconnected in ${((now() - t0) / 1000).toFixed(1)}s (previous connection up ${prevUp}, reason=${reason}, attempt ${attempt})`);
          return true;
        } catch (err) {
          if (stopped) break;
          const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
          log.error(`[lark] ws reconnect failed (attempt ${attempt}, reason=${reason}): ${err.message}; next retry in ${sec(delay)}s`);
          await sleepBackoff(delay);
        }
      }
      return false;
    } finally {
      state.reconnecting = false;
    }
  }

  function tick() {
    if (stopped || state.reconnecting || !wsClient || !state.clientStartedAt) return;
    const intervalMs = getPingIntervalMs();
    const timeoutMs = getTimeoutMs(intervalMs);
    const age = pongAgeMs();
    const sinceStart = now() - state.clientStartedAt;

    // Self-check: detection may be broken (e.g. SDK upgrade renamed internals).
    if (!state.everSeenPong && !state.selfCheckWarned && sinceStart > 2 * intervalMs) {
      state.selfCheckWarned = true;
      log.warn(`[lark] ws no pong observed ${sec(sinceStart)}s after connect (interval ${sec(intervalMs)}s) — pong detection may be broken (SDK internals changed?); half-open watchdog reconnects capped at ${MAX_BLIND_RECONNECTS} until a pong is seen`);
    }

    if (state.everSeenPong && !state.lateWarned && age > intervalMs + LATE_GRACE_MS) {
      state.lateWarned = true;
      log.warn(`[lark] ws pong late: last pong ${sec(age)}s ago (interval ${sec(intervalMs)}s)`);
    }

    if (pongTimeout.mode === 'disabled' || age <= timeoutMs) return;

    if (!state.everSeenPong) {
      if (state.blindReconnects >= MAX_BLIND_RECONNECTS) {
        if (!state.blindSuppressedWarned) {
          state.blindSuppressedWarned = true;
          log.warn(`[lark] ws pong-timeout reconnect suppressed: no pong has ever been observed in this process (detection likely broken); watchdog idle until a pong is seen`);
        }
        return;
      }
      state.blindReconnects++;
    }

    log.error(`[lark] ws half-open detected: no pong for ${sec(age)}s (timeout ${sec(timeoutMs)}s) -> reconnecting`);
    reconnect('pong-timeout').catch((err) => {
      log.error(`[lark] ws reconnect error: ${err.message}`);
    });
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
    if (!watchdogTimer) watchdogTimer = unref(setIntervalFn(tick, WATCHDOG_TICK_MS));
    if (!summaryTimer) summaryTimer = unref(setIntervalFn(summary, SUMMARY_INTERVAL_MS));
  }

  /**
   * Start WebSocket transport.
   * @param {object} config - from getConfig()
   * @param {object} credentials - { app_id, app_secret }
   * @param {function} handleMessageEvent - the message handler from index.js
   * @param {function} isDuplicate - dedup check function from index.js
   */
  async function start(config, credentials, handleMessageEvent, isDuplicate) {
    stopped = false;
    startArgs = { config, credentials };
    pongTimeout = parsePongTimeout(config?.ws_pong_timeout_sec, log);

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

    await openClient({ waitOpen: false });
    startTimers();
    const timeoutDesc = pongTimeout.mode === 'disabled'
      ? 'disabled'
      : pongTimeout.mode === 'fixed' ? `${sec(pongTimeout.ms)}s` : `${PONG_TIMEOUT_MULTIPLIER} x ping interval`;
    log.log(`[lark] WebSocket client started (pong timeout: ${timeoutDesc})`);
  }

  /** Stop WebSocket transport. Call this during shutdown. */
  function stop() {
    stopped = true;
    if (watchdogTimer) { clearIntervalFn(watchdogTimer); watchdogTimer = null; }
    if (summaryTimer) { clearIntervalFn(summaryTimer); summaryTimer = null; }
    if (backoffTimer) { clearTimeoutFn(backoffTimer); backoffTimer = null; }
    if (backoffResolve) { const r = backoffResolve; backoffResolve = null; r(); }
    if (!wsClient) return;
    const old = wsClient;
    wsClient = null;
    clientGen++;
    retireClient(old, log);
    state.connected = false;
    log.log('[lark] WebSocket client stopped');
  }

  /** Current connection state for /health endpoint. */
  function getState() {
    const age = state.lastPongAt ? now() - state.lastPongAt : null;
    return {
      connected: state.connected,
      connectedSince: state.connectedSince,
      lastPongAt: state.lastPongAt ? new Date(state.lastPongAt).toISOString() : null,
      lastPongAgeSec: age == null ? null : sec(age),
      pongCount: state.pongCount,
      reconnects: state.reconnects,
      lastReconnectReason: state.lastReconnectReason,
      lastReconnectAt: state.lastReconnectAt,
      reconnecting: state.reconnecting,
    };
  }

  return {
    start,
    stop,
    getConnectionState: getState,
    // exposed for tests
    _tick: tick,
    _summary: summary,
    _reconnect: reconnect,
    _getClient: () => wsClient,
  };
}

const defaultTransport = createWebSocketTransport();

export function startWebSocket(config, credentials, handleMessageEvent, isDuplicate) {
  return defaultTransport.start(config, credentials, handleMessageEvent, isDuplicate);
}

export function stopWebSocket() {
  defaultTransport.stop();
}

export function getConnectionState() {
  return defaultTransport.getConnectionState();
}
