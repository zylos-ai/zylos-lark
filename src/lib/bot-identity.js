/**
 * Bot identity (open_id) tracking.
 *
 * Group @mention detection compares mention ids against the bot's own
 * open_id. If that id is unknown every group @mention is treated as "not
 * mentioned", so this module keeps the identity available as reliably as
 * possible while bounding the number of getBotInfo requests:
 *
 * 1. Cached identity: config.bot.open_id is used immediately at startup when
 *    config.bot.app_id matches the current app (or is absent in older
 *    configs). Zero requests.
 * 2. Startup fetch: getBotInfo is called once at startup, as before. A
 *    successful result wins over the cached value and is written back
 *    (open_id + app_id).
 * 3. One-shot refetch: if the startup fetch failed and there is no usable
 *    cached identity, the first received message event triggers exactly one
 *    more getBotInfo call, awaited (bounded by a timeout) before the mention
 *    check. It is marked used before the request starts and never repeated,
 *    whatever the outcome. At most 2 getBotInfo calls per process; there is
 *    deliberately no timed or periodic retry.
 * 4. While the identity stays unknown, an error is logged every 10 minutes
 *    (log only, no requests) and status() exposes it for /health.
 */

export const REFETCH_TIMEOUT_MS = 5_000;
export const UNKNOWN_LOG_INTERVAL_MS = 10 * 60 * 1000;

const TOKEN_DESTRUCTURE_PATTERN = /Cannot destructure property 'tenant_access_token'/;
const TOKEN_HINT = 'tenant token fetch failed: network unreachable or bad app credentials';

/**
 * The Lark SDK swallows a failed tenant-token request and then destructures
 * `undefined`, which surfaces as a confusing TypeError. Append a hint that
 * names the real cause.
 */
export function explainBotInfoError(message) {
  const text = message === undefined || message === null ? 'unknown error' : String(message);
  if (TOKEN_DESTRUCTURE_PATTERN.test(text) && !text.includes(TOKEN_HINT)) {
    return `${text} (${TOKEN_HINT})`;
  }
  return text;
}

function withTimeout(promise, ms, setTimer, clearTimer) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimer(() => resolve({ timedOut: true }), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([
    promise.then((value) => ({ timedOut: false, value })),
    timeout,
  ]).finally(() => clearTimer(timer));
}

/**
 * @param {object} opts
 * @param {() => Promise<{success:boolean, open_id?:string, app_name?:string, message?:string}>} opts.fetchBotInfo
 * @param {string} [opts.appId] current LARK_APP_ID
 * @param {(identity:{openId:string, appId:string}) => void} [opts.persist] write open_id + app_id back to config
 * @param {(identity:{openId:string, appName:string, appId:string}) => void} [opts.onChange]
 */
export function createBotIdentity({
  fetchBotInfo,
  appId = '',
  persist = () => {},
  onChange = () => {},
  now = () => Date.now(),
  log = (msg) => console.log(msg),
  logError = (msg) => console.error(msg),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  setRepeat = setInterval,
  clearRepeat = clearInterval,
  refetchTimeoutMs = REFETCH_TIMEOUT_MS,
  unknownLogIntervalMs = UNKNOWN_LOG_INTERVAL_MS,
} = {}) {
  const normalizedAppId = appId ? String(appId) : '';
  const state = {
    openId: '',
    appName: 'bot',
    appId: normalizedAppId,
    status: 'unknown', // cached | fetched | unknown
    since: now(),
    attempts: 0,
  };
  let startupPromise = null;
  let startupSettled = false;
  let refetchUsed = false;
  let refetchWait = null;
  let unknownTimer = null;

  function setStatus(status) {
    if (state.status !== status) {
      state.status = status;
      state.since = now();
    }
  }

  function notify() {
    onChange({ openId: state.openId, appName: state.appName, appId: state.appId });
  }

  function stopUnknownLog() {
    if (unknownTimer) {
      clearRepeat(unknownTimer);
      unknownTimer = null;
    }
  }

  function startUnknownLog() {
    if (unknownTimer || state.status !== 'unknown') return;
    unknownTimer = setRepeat(() => {
      if (state.status !== 'unknown') {
        stopUnknownLog();
        return;
      }
      const minutes = Math.round((now() - state.since) / 60_000);
      logError(`[lark] ERROR bot identity unknown for ${minutes}m — group @mentions are NOT detected; restart the service once Lark is reachable`);
    }, unknownLogIntervalMs);
    if (unknownTimer && typeof unknownTimer.unref === 'function') unknownTimer.unref();
  }

  function applyFetched(info) {
    const openId = String(info.open_id);
    if (state.status === 'cached' && state.openId && state.openId !== openId) {
      log(`[lark] Cached bot open_id ${state.openId} differs from fetched ${openId}; using fetched value`);
    }
    state.openId = openId;
    state.appName = info.app_name || 'bot';
    setStatus('fetched');
    stopUnknownLog();
    notify();
    try {
      persist({ openId, appId: state.appId });
    } catch (err) {
      logError(`[lark] Failed to persist bot identity: ${err.message}`);
    }
  }

  async function callFetch() {
    state.attempts += 1;
    try {
      const info = await fetchBotInfo();
      if (info && info.success && info.open_id) return { ok: true, info };
      return { ok: false, message: explainBotInfoError(info?.message || 'empty bot info') };
    } catch (err) {
      return { ok: false, message: explainBotInfoError(err?.message) };
    }
  }

  /**
   * Use config.bot.open_id when it belongs to the current app. Returns true
   * when a cached identity was applied.
   */
  function loadCached(botConfig) {
    const cachedOpenId = botConfig?.open_id ? String(botConfig.open_id) : '';
    if (!cachedOpenId) return false;
    const cachedAppId = botConfig?.app_id ? String(botConfig.app_id) : '';
    if (cachedAppId && cachedAppId !== normalizedAppId) {
      log(`[lark] Ignoring cached bot identity: cached app_id ${cachedAppId} does not match current app ${normalizedAppId || '(unset)'}`);
      return false;
    }
    state.openId = cachedOpenId;
    setStatus('cached');
    notify();
    log(`[lark] Using cached bot identity (${cachedOpenId})`);
    return true;
  }

  /** The single startup getBotInfo call. */
  function fetchAtStartup() {
    if (startupPromise) return startupPromise;
    startupPromise = (async () => {
      const result = await callFetch();
      startupSettled = true;
      if (result.ok) {
        applyFetched(result.info);
        log(`[lark] Bot identity: ${state.appName} (${state.openId}, ${state.appId})`);
        return;
      }
      logError(`[lark] Warning: Could not fetch bot info: ${result.message}`);
      if (state.status === 'cached') {
        log('[lark] Continuing with cached bot identity');
      } else {
        logError('[lark] @mention detection in groups will not work until the bot identity is recovered (one retry on the first received message)');
        startUnknownLog();
      }
    })();
    return startupPromise;
  }

  async function runRefetch() {
    const result = await callFetch();
    if (result.ok) {
      applyFetched(result.info);
      log(`[lark] Bot identity recovered on first message: ${state.appName} (${state.openId}, ${state.appId})`);
      return;
    }
    logError(`[lark] ERROR bot identity refetch failed: ${result.message} — no further attempts; group @mentions are NOT detected until restart`);
    startUnknownLog();
  }

  /**
   * Call before the mention check of every received message event. Resolves
   * immediately unless the identity is unknown; the first such call issues
   * the one-shot refetch and every caller waits on that same request (up to
   * refetchTimeoutMs).
   */
  async function ensureForMessage() {
    if (state.status !== 'unknown') return;
    if (refetchWait) {
      await refetchWait;
      return;
    }
    if (refetchUsed) return;
    if (startupPromise && !startupSettled) {
      // The startup call is still in flight: wait for it (bounded) instead of
      // issuing a parallel request.
      await withTimeout(startupPromise, refetchTimeoutMs, setTimer, clearTimer);
      if (state.status !== 'unknown' || !startupSettled) return;
      if (refetchWait) {
        await refetchWait;
        return;
      }
      if (refetchUsed) return;
    }
    refetchUsed = true;
    refetchWait = withTimeout(runRefetch(), refetchTimeoutMs, setTimer, clearTimer);
    const outcome = await refetchWait;
    if (outcome.timedOut) {
      logError(`[lark] Bot identity refetch still pending after ${refetchTimeoutMs}ms; handling message with unknown identity`);
    }
  }

  function status() {
    return {
      status: state.status,
      since: new Date(state.since).toISOString(),
      attempts: state.attempts,
      refetchUsed,
    };
  }

  function stop() {
    stopUnknownLog();
  }

  return {
    get openId() { return state.openId; },
    get appName() { return state.appName; },
    get appId() { return state.appId; },
    loadCached,
    fetchAtStartup,
    ensureForMessage,
    status,
    stop,
  };
}
