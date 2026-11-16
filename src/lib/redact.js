/**
 * Log redaction.
 *
 * Keeps credentials out of the service logs (PM2 out.log / error.log):
 * app_secret, tenant/user/app access tokens, Authorization headers,
 * encrypt_key, verification_token and similar values.
 *
 * Where secrets come from:
 * - The Lark SDK logs caught errors through its logger. With the SDK's
 *   default logger a failed tenant-token request dumps the whole AxiosError,
 *   whose `config.data` is the JSON body `{"app_id":..,"app_secret":..}` and
 *   whose `config.headers` may carry `Authorization: Bearer <token>`.
 *   `createRedactingLogger()` is passed as `logger` to every SDK client
 *   (Client, WSClient, EventDispatcher) so those arguments are sanitized
 *   before they are printed.
 * - The service's own console output. `installConsoleRedaction()` wraps the
 *   console methods of the service process as a safety net.
 *
 * `redact()` returns a sanitized copy and never mutates its input. Errors
 * keep their name, message, stack, code, cause and (for axios errors) method,
 * url, status and response data, so the log stays useful.
 */

export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 6;
const MIN_KNOWN_SECRET_LENGTH = 8;

// Object keys whose values are always redacted. Compared after lowercasing
// and removing '-' / '_', so `app_secret`, `appSecret` and `App-Secret` match.
const SENSITIVE_KEYS = new Set([
  'appsecret',
  'clientsecret',
  'secret',
  'accesstoken',
  'tenantaccesstoken',
  'useraccesstoken',
  'appaccesstoken',
  'refreshtoken',
  'token',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'encryptkey',
  'verificationtoken',
  'appticket',
  'ticket',
  'accesskey',
  'password',
  'xinternaltoken',
]);

/** True when values stored under `key` must not be logged. */
export function isSensitiveKey(key) {
  if (typeof key !== 'string') return false;
  const k = key.toLowerCase().replace(/[-_]/g, '');
  return SENSITIVE_KEYS.has(k)
    || k.endsWith('secret')
    || k.endsWith('accesstoken')
    || k.endsWith('refreshtoken')
    || k.endsWith('password');
}

// Key names recognised inside free text: JSON bodies ("app_secret":"..."),
// inspected objects (app_secret: '...'), query strings (ticket=...).
const TEXT_KEYS = [
  'app_?secret', 'client_?secret',
  '(?:tenant|user|app)_?access_?token', 'access_?token', 'refresh_?token',
  'encrypt_?key', 'verification_?token',
  'app_?ticket', 'ticket', 'access_?key',
  'x-internal-token', 'password', 'secret', 'token',
].join('|');

// prefix: optional (escaped) quote, key, optional quote, ':' or '='.
// value: \"escaped\" | "double" | 'single' | bare word (not already redacted).
const KEY_VALUE_RE = new RegExp(
  `((?:\\\\?["'])?\\b(?:${TEXT_KEYS})(?:\\\\?["'])?\\s*[:=]\\s*)`
  + `(\\\\"[^"]*?\\\\"|"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|(?!\\[REDACTED\\])[^\\s,&;}'"\\]]+)`,
  'gi',
);
const AUTH_SCHEME_RE = /\b(Bearer|Basic)\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]+/gi;
// Lark token shapes: t- (tenant), u- (user), a- (app), ur- (refresh).
const LARK_TOKEN_RE = /\b(?:t|u|a|ur)-[A-Za-z0-9._]{20,}/g;

const knownSecrets = new Set();

/**
 * Register literal secret values (e.g. LARK_APP_SECRET) so they are removed
 * from any logged text even when they appear without a recognisable key.
 * Values shorter than 8 characters are ignored to avoid mangling logs.
 */
export function registerSecrets(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.length >= MIN_KNOWN_SECRET_LENGTH) knownSecrets.add(v);
  }
}

/** Test helper: forget registered secrets. */
export function clearRegisteredSecrets() {
  knownSecrets.clear();
}

function redactQuotedValue(value) {
  if (value.startsWith('\\"')) return `\\"${REDACTED}\\"`;
  if (value.startsWith('"')) return `"${REDACTED}"`;
  if (value.startsWith("'")) return `'${REDACTED}'`;
  return REDACTED;
}

/** Redact secrets from a string. */
export function redactText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  out = out.replace(AUTH_SCHEME_RE, (_m, scheme) => `${scheme} ${REDACTED}`);
  out = out.replace(KEY_VALUE_RE, (_m, prefix, value) => prefix + redactQuotedValue(value));
  out = out.replace(LARK_TOKEN_RE, REDACTED);
  return out;
}

function isBinary(v) {
  return Buffer.isBuffer(v) || ArrayBuffer.isView(v) || v instanceof ArrayBuffer;
}

function redactError(err, depth, seen) {
  const out = new Error(redactText(String(err.message ?? '')));
  out.name = err.name;
  out.stack = typeof err.stack === 'string' ? redactText(err.stack) : out.stack;

  if (err.isAxiosError) {
    // Summarize instead of copying config/request/response: they hold the
    // request body, headers and socket internals.
    const cfg = err.config || {};
    if (err.code !== undefined) out.code = err.code;
    if (cfg.method) out.method = String(cfg.method).toUpperCase();
    const url = cfg.url ? (cfg.baseURL && !/^https?:/i.test(cfg.url) ? cfg.baseURL + cfg.url : cfg.url) : undefined;
    if (url) out.url = redactText(String(url));
    const status = err.response?.status ?? err.status;
    if (status !== undefined) out.status = status;
    if (err.response && err.response.data !== undefined) {
      out.responseData = redactValue(err.response.data, depth + 1, seen);
    }
  } else {
    for (const key of Object.keys(err)) {
      if (key === 'message' || key === 'stack') continue;
      out[key] = isSensitiveKey(key) ? REDACTED : redactValue(err[key], depth + 1, seen);
    }
  }
  if (err.cause !== undefined) out.cause = redactValue(err.cause, depth + 1, seen);
  return out;
}

function redactValue(value, depth, seen) {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (isBinary(value)) return `[binary ${value.byteLength ?? value.length} bytes]`;
  if (value instanceof Date || value instanceof RegExp) return value;
  if (seen.has(value)) return '[Circular]';
  if (depth > MAX_DEPTH) return Array.isArray(value) ? '[Array]' : '[Object]';
  seen.add(value);
  try {
    if (value instanceof Error) return redactError(value, depth, seen);
    if (Array.isArray(value)) return value.map(v => redactValue(v, depth + 1, seen));
    if (value instanceof Map) {
      const out = new Map();
      for (const [k, v] of value) out.set(k, isSensitiveKey(k) ? REDACTED : redactValue(v, depth + 1, seen));
      return out;
    }
    if (value instanceof Set) return new Set([...value].map(v => redactValue(v, depth + 1, seen)));
    const out = {};
    for (const key of Object.keys(value)) {
      let v;
      try { v = value[key]; } catch { v = '[unreadable]'; }
      out[key] = isSensitiveKey(key) && v !== undefined && v !== null && v !== '' ? REDACTED : redactValue(v, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Return a log-safe copy of `value` (string, Error, AxiosError, array or
 * nested object). The input is not modified.
 */
export function redact(value) {
  try {
    return redactValue(value, 0, new Set());
  } catch {
    return '[unloggable value]';
  }
}

/**
 * Logger for the Lark SDK (`logger` option of Client / WSClient /
 * EventDispatcher). Same output format and streams as the SDK's default
 * logger, with every argument passed through redact().
 */
export function createRedactingLogger(out = console) {
  const r = (args) => args.map(redact);
  return {
    error: (...msg) => out.log('[error]:', ...r(msg)),
    warn: (...msg) => out.warn('[warn]:', ...r(msg)),
    info: (...msg) => out.info('[info]:', ...r(msg)),
    debug: (...msg) => out.debug('[debug]:', ...r(msg)),
    trace: (...msg) => out.trace('[trace]:', ...r(msg)),
  };
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
const INSTALLED = Symbol.for('zylos-lark.consoleRedaction');

/**
 * Wrap console methods so every argument is redacted before printing.
 * Idempotent. Returns a function that restores the original methods.
 */
export function installConsoleRedaction(target = console) {
  if (target[INSTALLED]) return target[INSTALLED];
  const originals = {};
  for (const name of CONSOLE_METHODS) {
    const orig = target[name];
    if (typeof orig !== 'function') continue;
    originals[name] = orig;
    target[name] = function redactedConsole(...args) {
      return orig.apply(this, args.map(redact));
    };
  }
  const restore = () => {
    for (const [name, orig] of Object.entries(originals)) target[name] = orig;
    delete target[INSTALLED];
  };
  target[INSTALLED] = restore;
  return restore;
}
