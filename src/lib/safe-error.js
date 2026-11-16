/**
 * Safe error/log formatting
 *
 * axios errors carry `config` (request body + headers), `request` and
 * `response.config`. Logging the whole object leaks credentials — e.g. the
 * tenant_access_token request body contains app_secret. Everything that may
 * log an error object (our code and the Lark SDK logger) goes through here
 * and only emits: code, message, HTTP status, Lark API code/msg, method and
 * URL path (no query string).
 */

const SENSITIVE_KEY = /secret|token|authorization|password|cookie|credential/i;
const MAX_STRING = 500;

function urlPath(url, baseURL) {
  if (!url || typeof url !== 'string') return undefined;
  try {
    return new URL(url, baseURL || 'http://local.invalid').pathname;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

function isErrorLike(value) {
  return value instanceof Error
    || (value && typeof value === 'object'
      && ('isAxiosError' in value || 'config' in value || 'request' in value || 'response' in value));
}

/**
 * Reduce an error (axios or otherwise) to a plain object of safe fields.
 */
export function safeError(err) {
  if (err === null || err === undefined) return { message: String(err) };
  if (typeof err !== 'object') return { message: String(err).slice(0, MAX_STRING) };

  const out = {};
  if (err.code !== undefined) out.code = err.code;
  if (err.message !== undefined) out.message = String(err.message).slice(0, MAX_STRING);

  const res = err.response;
  if (res && typeof res === 'object') {
    if (res.status !== undefined) out.status = res.status;
    const data = res.data;
    if (data && typeof data === 'object' && !Buffer.isBuffer(data)) {
      if (data.code !== undefined) out.apiCode = data.code;
      if (data.msg !== undefined) out.apiMsg = String(data.msg).slice(0, MAX_STRING);
    }
  }

  const cfg = err.config;
  if (cfg && typeof cfg === 'object') {
    if (cfg.method) out.method = String(cfg.method).toUpperCase();
    const p = urlPath(cfg.url, cfg.baseURL);
    if (p) out.path = p;
  }
  return out;
}

/**
 * One-line string form of safeError().
 */
export function formatSafeError(err) {
  const e = safeError(err);
  const parts = [];
  if (e.method || e.path) parts.push(`${e.method || ''} ${e.path || ''}`.trim());
  if (e.code !== undefined) parts.push(`code=${e.code}`);
  if (e.status !== undefined) parts.push(`status=${e.status}`);
  if (e.apiCode !== undefined) parts.push(`apiCode=${e.apiCode}`);
  if (e.apiMsg !== undefined) parts.push(`apiMsg=${e.apiMsg}`);
  const head = e.message !== undefined ? e.message : 'error';
  return parts.length ? `${head} (${parts.join(', ')})` : head;
}

function redactObject(value) {
  try {
    const json = JSON.stringify(value, (key, v) => (key && SENSITIVE_KEY.test(key) ? '[REDACTED]' : v));
    if (json === undefined) return String(value);
    return json.length > MAX_STRING ? `${json.slice(0, MAX_STRING)}...` : json;
  } catch {
    return '[unserializable]';
  }
}

/**
 * Make an arbitrary log argument safe to print.
 */
export function sanitizeLogArg(arg) {
  if (typeof arg === 'string') return arg;
  if (arg === null || typeof arg !== 'object') return String(arg);
  if (Array.isArray(arg)) return arg.map(sanitizeLogArg).join(' ');
  if (isErrorLike(arg)) return formatSafeError(arg);
  return redactObject(arg);
}

/**
 * Logger for the Lark SDK (`logger` option of Client / WSClient).
 * The SDK's LoggerProxy passes all arguments as one array; the default
 * logger prints raw axios errors (incl. config.data with app_secret).
 */
export function createSafeSdkLogger(base = console) {
  const emit = (fn, tag) => (...args) => fn.call(base, tag, sanitizeLogArg(args));
  return {
    error: emit(base.error, '[error]:'),
    warn: emit(base.warn, '[warn]:'),
    info: emit(base.info, '[info]:'),
    debug: emit(base.debug, '[debug]:'),
    trace: emit(base.debug, '[trace]:'),
  };
}
