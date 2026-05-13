/**
 * lark-cli bridge — runtime helper for invoking `lark-cli` from zylos-lark.
 *
 * Two responsibilities:
 *   1. Run `lark-cli <args>` and, on failure, parse lark-cli's structured
 *      JSON error envelope. If the error indicates user-level OAuth is
 *      required, throw a typed LarkCliAuthRequiredError instead of the
 *      raw child_process error.
 *   2. Provide a convenience helper that DMs the owner with the auth
 *      instructions when such an error occurs.
 *
 * Design notes:
 *   - runLarkCli is pure-ish: it only runs lark-cli and throws. It does
 *     NOT auto-send DMs. The caller decides whether to call
 *     notifyOwnerAuthRequired(). This keeps the bridge testable and
 *     usable from contexts where side effects aren't wanted.
 *   - Args are passed as an array to execFileSync (no shell), avoiding
 *     command injection from user-provided fragments.
 *   - lark-cli's auth-failure type pattern is `<domain>_user_login_required`
 *     (e.g. calendar_user_login_required). Confirmed empirically; see
 *     docs/INTEGRATE-LARK-CLI.md §6 for the list of known anchors.
 */

import { execFileSync } from 'child_process';
import { sendToUser } from './message.js';
import { getConfig } from './config.js';

const AUTH_REQUIRED_TYPE_REGEX = /_user_login_required$/;

/**
 * Thrown when `lark-cli` returns an error that indicates the current
 * user identity is not authenticated (user_access_token missing or expired).
 */
export class LarkCliAuthRequiredError extends Error {
  constructor(domain, hint, errorInfo, originalError) {
    super(`lark-cli requires user login for domain: ${domain || '(unknown)'}`);
    this.name = 'LarkCliAuthRequiredError';
    this.domain = domain;
    this.hint = hint;
    this.errorInfo = errorInfo;       // full {type, message, hint, ...} from lark-cli
    this.originalError = originalError; // underlying child_process error
  }
}

/**
 * Run a `lark-cli` command synchronously.
 *
 * @param {string[]} args  argv for lark-cli, e.g. ['calendar', '+create', '--as', 'bot']
 * @param {object}   opts  forwarded to execFileSync (encoding, env, cwd, timeout, ...)
 * @returns {string} stdout
 * @throws {LarkCliAuthRequiredError} when lark-cli reports *_user_login_required
 * @throws {Error}                    other lark-cli failures (rethrown unchanged)
 */
export function runLarkCli(args, opts = {}) {
  if (!Array.isArray(args)) {
    throw new TypeError('runLarkCli: args must be an array of strings');
  }
  try {
    return execFileSync('lark-cli', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
  } catch (err) {
    const combined = String(err.stdout || '') + String(err.stderr || '');
    const errorInfo = parseLarkCliError(combined);
    if (errorInfo && AUTH_REQUIRED_TYPE_REGEX.test(errorInfo.type || '')) {
      const domain = inferDomain(errorInfo.type, args);
      throw new LarkCliAuthRequiredError(domain, errorInfo.hint, errorInfo, err);
    }
    throw err;
  }
}

/**
 * Parse lark-cli's structured error envelope from combined stdout+stderr.
 *
 * lark-cli emits errors as:
 *   {
 *     "ok": false,
 *     "identity": "bot" | "user",
 *     "error": { "type": "...", "message": "...", "hint": "...", ... }
 *   }
 *
 * Output may be prefixed by a `tip:` line on stderr; we scan for the first
 * line that opens an object and parse from there to end-of-text.
 *
 * @param {string} text
 * @returns {object|null} the `error` sub-object, or null if unparseable
 */
export function parseLarkCliError(text) {
  if (!text) return null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('{')) {
      const remaining = lines.slice(i).join('\n').trim();
      try {
        const obj = JSON.parse(remaining);
        return (obj && typeof obj === 'object' && obj.error) ? obj.error : null;
      } catch {
        // Not a complete JSON from this line — keep looking.
      }
    }
  }
  return null;
}

/**
 * Infer the auth `--domain` value from an error type or from argv.
 *
 * lark-cli error types for auth failures follow `<domain>_user_login_required`,
 * where domain matches the `lark-cli auth login --domain <domain>` value.
 * If the type doesn't carry a prefix, fall back to argv[0] (service name).
 */
function inferDomain(errorType, args) {
  const m = /^([a-z][a-z0-9_-]*)_user_login_required$/.exec(errorType || '');
  if (m) return m[1];
  return Array.isArray(args) && args[0] ? args[0] : null;
}

/**
 * DM the configured owner with instructions to complete `lark-cli auth login`.
 *
 * Owner open_id is read from zylos-lark's config (config.owner.open_id),
 * which is populated when the first DM binds an owner. If no owner is
 * bound yet, the function logs a warning and returns false rather than
 * throwing — the auth-required error has already been surfaced upstream.
 *
 * @param {LarkCliAuthRequiredError} err
 * @param {object} [opts]
 * @param {string} [opts.ownerOpenId] explicit override
 * @returns {Promise<boolean>} true if DM was sent
 */
export async function notifyOwnerAuthRequired(err, opts = {}) {
  let ownerOpenId = opts.ownerOpenId;
  if (!ownerOpenId) {
    try {
      const cfg = getConfig();
      ownerOpenId = cfg?.owner?.open_id;
    } catch {
      // Config not loadable — probably running outside the zylos-lark runtime.
    }
  }
  if (!ownerOpenId) {
    console.warn('[lark-cli-bridge] cannot notify owner: config.owner.open_id is not set');
    return false;
  }

  const domain = err.domain || 'lark-cli';
  const hint = err.hint || `lark-cli auth login --domain ${domain}`;
  const msg =
    `lark-cli 需要你的用户级登录(domain: ${domain})。\n` +
    `请在终端执行:\n\n` +
    `    ${hint}\n\n` +
    `扫码完成后告诉我"已登录",我会重试当前操作。`;

  await sendToUser(ownerOpenId, msg, 'text');
  return true;
}
