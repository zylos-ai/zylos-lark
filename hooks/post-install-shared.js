#!/usr/bin/env node
/**
 * Shared helpers for post-install and post-upgrade hooks.
 *
 * Three idempotent steps that integrate lark-cli into zylos-lark:
 *   1. installLarkCliBinary()           - probe + version check + install/upgrade
 *   2. installLarkCliSkills(skillDir)   - probe + version check + install/upgrade
 *   3. syncCredentialsToLarkCli(opts)   - read ~/zylos/.env, delegate to
 *                                          `lark-cli config init --app-secret-stdin`
 *                                          (skipped when unchanged; preserves
 *                                          logged-in users — issue #112)
 *
 * The target lark-cli version is read from package.json `larkCli.version`,
 * falling back to a hardcoded minimum for backward compatibility with
 * package.json files that predate the `larkCli` field.
 *
 * Each function throws on failure; the caller decides whether to abort.
 * See docs/INTEGRATE-LARK-CLI.md (§4.2, §4.6.1) for the design rationale.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
import { parse as parseDotenv } from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LARK_CLI_NPM_PACKAGE = '@larksuite/cli';
const FALLBACK_VERSION = '1.0.41';
const XC_SKILLS_SOURCE = 'https://github.com/larksuite/cli';
const EXPECTED_SUB_SKILLS = Object.freeze([
  'lark-apps',
  'lark-approval',
  'lark-attendance',
  'lark-base',
  'lark-calendar',
  'lark-contact',
  'lark-doc',
  'lark-drive',
  'lark-event',
  'lark-im',
  'lark-mail',
  'lark-markdown',
  'lark-minutes',
  'lark-note',
  'lark-okr',
  'lark-openapi-explorer',
  'lark-shared',
  'lark-sheets',
  'lark-skill-maker',
  'lark-slides',
  'lark-task',
  'lark-vc',
  'lark-vc-agent',
  'lark-whiteboard',
  'lark-wiki',
  'lark-workflow-meeting-summary',
  'lark-workflow-standup-report',
]);
const LARK_BRAND = 'lark';
const DEFAULT_LARK_LANG = 'zh';
const DEFAULT_ENV_FILE = path.join(process.env.HOME || '', 'zylos/.env');
const LOG_PREFIX = '[zylos-lark]';
const SKILLS_VERSION_FILE = '.lark-cli-version';

/**
 * Read the target lark-cli version from package.json `larkCli.version`.
 * Falls back to FALLBACK_VERSION for old package.json without the field.
 */
function getTargetVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8')
    );
    return pkg.larkCli?.version || FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the installed lark-cli version string, or null if not installed.
 * Parses output like "lark-cli version 1.0.41" → "1.0.41".
 */
function getInstalledVersion() {
  try {
    const out = execSync('lark-cli --version', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = out.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Compare two semver strings. Returns:
 *   -1 if a < b, 0 if a == b, 1 if a > b.
 */
function semverCompare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

/**
 * Ensure the `lark-cli` binary is on PATH at the target version.
 * - Not installed → fresh install
 * - Installed but older than target → upgrade
 * - Installed at or above target → skip
 */
export function installLarkCliBinary() {
  const target = getTargetVersion();
  const installed = getInstalledVersion();

  if (installed) {
    if (semverCompare(installed, target) >= 0) {
      console.log(`${LOG_PREFIX} lark-cli ${installed} >= target ${target}, skipping`);
      return;
    }
    console.log(`${LOG_PREFIX} lark-cli ${installed} < target ${target}, upgrading`);
  } else {
    console.log(`${LOG_PREFIX} lark-cli not found, installing ${target}`);
  }

  execSync(`npm install -g ${LARK_CLI_NPM_PACKAGE}@${target}`, { stdio: 'inherit' });

  if (!commandExists('lark-cli')) {
    throw new Error(
      `lark-cli not found in PATH after npm install -g ${LARK_CLI_NPM_PACKAGE}@${target}`
    );
  }

  const newVersion = getInstalledVersion();
  console.log(`${LOG_PREFIX} lark-cli now at ${newVersion}`);
}

/**
 * Install or upgrade lark-cli's bundled Agent Skills into `<skillDir>/references/`.
 *
 * Triggers a (re-)install when:
 *   - Any sub-skill directory is missing (partial install / manual deletion)
 *   - The version marker file is absent (legacy install) or below target
 */
export function installLarkCliSkills(skillDir) {
  if (!skillDir) {
    throw new Error('installLarkCliSkills: skillDir is required');
  }
  const target = getTargetVersion();
  const bundlesDir = path.join(skillDir, 'references');
  fs.mkdirSync(bundlesDir, { recursive: true });

  const versionFile = path.join(bundlesDir, SKILLS_VERSION_FILE);

  const findMissing = () =>
    EXPECTED_SUB_SKILLS.filter(
      (name) => !fs.existsSync(path.join(bundlesDir, name, 'SKILL.md'))
    );

  let installedSkillsVersion = null;
  try {
    installedSkillsVersion = fs.readFileSync(versionFile, 'utf-8').trim();
  } catch { /* missing = needs install */ }

  const missing = findMissing();
  const needsVersionUpgrade =
    !installedSkillsVersion || semverCompare(installedSkillsVersion, target) < 0;

  if (missing.length === 0 && !needsVersionUpgrade) {
    console.log(
      `${LOG_PREFIX} all ${EXPECTED_SUB_SKILLS.length} sub-skills present at ${installedSkillsVersion}, skipping`
    );
    return;
  }

  if (needsVersionUpgrade) {
    console.log(
      `${LOG_PREFIX} sub-skills version ${installedSkillsVersion || '(none)'} → ${target}, upgrading`
    );
  }
  if (missing.length > 0) {
    console.log(
      `${LOG_PREFIX} ${missing.length}/${EXPECTED_SUB_SKILLS.length} sub-skill(s) missing, repairing`
    );
  }

  execSync(
    `npx xc-skills@latest add ${XC_SKILLS_SOURCE}#v${target} --out "${bundlesDir}" -y`,
    { stdio: 'inherit' }
  );

  const stillMissing = findMissing();
  if (stillMissing.length > 0) {
    throw new Error(
      `installLarkCliSkills: still missing after install: ${stillMissing.join(', ')}`
    );
  }

  fs.writeFileSync(versionFile, target + '\n');
  console.log(`${LOG_PREFIX} sub-skills updated to ${target}`);
}

// ---------------------------------------------------------------------------
// lark-cli config.json preservation (issue #112)
//
// `lark-cli config init` (non-profile mode) rewrites config.json from scratch
// as a single app with `users: []` (lark-cli v1.0.81 cmd/config/init.go
// saveInitConfig → saveAsOnlyApp). The encrypted user tokens for the same
// appId survive, only the config entries pointing at them are lost. To keep
// `lark-cli auth login` identities across install/upgrade we:
//   1. skip `config init` entirely when nothing changed (see canSkipConfigInit)
//   2. otherwise snapshot the same-appId user state before init and restore
//      it afterwards (never across a different appId)
//   3. warn when a user identity present before the sync is missing after it
// ---------------------------------------------------------------------------

const SYNC_STATE_VERSION = 1;
const DEFAULT_SYNC_STATE_FILE = path.join(
  process.env.HOME || '', 'zylos/components/lark/lark-cli-sync.json'
);

// lark-cli canonical locales and their short forms (internal/i18n/lang.go).
// `config init --lang zh` is stored as "zh_cn".
const LARK_LANG_SHORT_TO_LOCALE = Object.freeze({
  zh: 'zh_cn', en: 'en_us', ja: 'ja_jp', ko: 'ko_kr', fr: 'fr_fr', de: 'de_de',
  es: 'es_es', it: 'it_it', ru: 'ru_ru', pt: 'pt_br', th: 'th_th', vi: 'vi_vn',
  id: 'id_id', ms: 'ms_my',
});
const LARK_LOCALES = new Set(Object.values(LARK_LANG_SHORT_TO_LOCALE));

/** Canonical lark-cli locale for `lang`, or null if lark-cli would not know it. */
export function normalizeLarkLang(lang) {
  if (!lang) return null;
  if (Object.hasOwn(LARK_LANG_SHORT_TO_LOCALE, lang)) return LARK_LANG_SHORT_TO_LOCALE[lang];
  return LARK_LOCALES.has(lang) ? lang : null;
}

/** lark-cli's config.json path (honours LARKSUITE_CLI_CONFIG_DIR like lark-cli). */
export function getLarkCliConfigPath(env = process.env) {
  const base = env.LARKSUITE_CLI_CONFIG_DIR || path.join(env.HOME || '', '.lark-cli');
  return path.join(base, 'config.json');
}

/**
 * Read and parse a JSON file.
 * Returns { status: 'ok', data } | { status: 'missing' } | { status: 'invalid' }.
 */
function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { status: err.code === 'ENOENT' ? 'missing' : 'invalid' };
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { status: 'invalid' };
    return { status: 'ok', data };
  } catch {
    return { status: 'invalid' };
  }
}

/** Read lark-cli config.json; `data` is only set when it has an `apps` array. */
function readLarkCliConfig(configPath) {
  const res = readJsonFile(configPath);
  if (res.status === 'ok' && !Array.isArray(res.data.apps)) return { status: 'invalid' };
  return res;
}

/**
 * Write JSON atomically (temp file in the same dir + rename). Keeps the
 * existing file's permission bits, defaulting to 0600 for new files.
 */
function atomicWriteJson(filePath, obj, defaultMode = 0o600) {
  let mode = defaultMode;
  try {
    mode = fs.statSync(filePath).mode & 0o777;
  } catch { /* new file */ }
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2) + '\n', { mode });
    fs.chmodSync(tmpPath, mode); // writeFileSync's mode is subject to umask
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/** lark-cli's current app: `currentApp` (name, then appId) else apps[0]. */
function findCurrentApp(config) {
  const apps = config.apps;
  if (config.currentApp) {
    return apps.find((a) => a && a.name && a.name === config.currentApp)
      || apps.find((a) => a && a.appId === config.currentApp)
      || null;
  }
  return apps[0] || null;
}

function listUsers(config) {
  const out = [];
  if (!config) return out;
  for (const app of config.apps) {
    if (!app || !Array.isArray(app.users)) continue;
    for (const u of app.users) {
      if (u && u.userOpenId) out.push({ appId: app.appId, userOpenId: u.userOpenId, userName: u.userName || '' });
    }
  }
  return out;
}

function hmacSecret(salt, secret) {
  return crypto.createHmac('sha256', Buffer.from(salt, 'hex')).update(secret, 'utf-8').digest('hex');
}

function secretMatchesState(state, secret) {
  if (!state || typeof state.salt !== 'string' || typeof state.secretHmac !== 'string') return false;
  const expected = Buffer.from(state.secretHmac, 'hex');
  const actual = Buffer.from(hmacSecret(state.salt, secret), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/**
 * Decide whether `lark-cli config init` can be skipped: lark-cli's current
 * app already has the same appId / brand / lang, its secret points at the
 * keychain entry for that appId, and the .env secret matches the one we
 * last pushed (compared via a salted HMAC kept in our own state file —
 * lark-cli offers no way to compare the keychain secret, and we do not
 * read its keychain).
 */
function canSkipConfigInit({ config, state, appId, appSecret, brand, lang }) {
  if (!config) return false;
  const app = findCurrentApp(config);
  if (!app || app.appId !== appId || app.brand !== brand) return false;
  const wantLang = normalizeLarkLang(lang);
  if (!wantLang || app.lang !== wantLang) return false;
  const ref = app.appSecret;
  if (!ref || typeof ref !== 'object' || ref.source !== 'keychain' || ref.id !== `appsecret:${appId}`) {
    return false;
  }
  if (!state || state.version !== SYNC_STATE_VERSION || state.appId !== appId || state.brand !== brand) {
    return false;
  }
  return secretMatchesState(state, appSecret);
}

/**
 * Capture state that `config init` drops but that belongs to the same app:
 * users, per-app defaultAs / strictMode, and workspace-level policies.
 */
function snapshotPreservedState(config, appId) {
  if (!config) return null;
  const app = config.apps.find((a) => a && a.appId === appId) || null;
  return {
    users: app && Array.isArray(app.users) ? app.users.filter((u) => u && u.userOpenId) : [],
    appFields: app
      ? Object.fromEntries(['defaultAs', 'strictMode'].filter((k) => app[k] !== undefined).map((k) => [k, app[k]]))
      : {},
    topFields: Object.fromEntries(
      ['strictMode', 'riskControl'].filter((k) => config[k] !== undefined).map((k) => [k, config[k]])
    ),
  };
}

/**
 * Merge the snapshot back into the freshly initialised config. Users are
 * only restored into the entry with the same appId. Returns the number of
 * restored users (0 when nothing needed to be restored).
 */
function restorePreservedState(configPath, snapshot, appId) {
  const res = readLarkCliConfig(configPath);
  if (res.status !== 'ok') {
    console.warn(`${LOG_PREFIX} lark-cli config.json unreadable after config init; cannot restore user list`);
    return 0;
  }
  const config = res.data;
  const app = config.apps.find((a) => a && a.appId === appId);
  if (!app) {
    console.warn(`${LOG_PREFIX} app ${appId} missing from lark-cli config.json after config init; cannot restore user list`);
    return 0;
  }
  let changed = false;
  const existingUsers = Array.isArray(app.users) ? app.users : [];
  const seen = new Set(existingUsers.map((u) => u && u.userOpenId));
  const toAdd = snapshot.users.filter((u) => !seen.has(u.userOpenId));
  if (toAdd.length > 0 || !Array.isArray(app.users)) {
    app.users = [...existingUsers, ...toAdd];
    changed = true;
  }
  for (const [k, v] of Object.entries(snapshot.appFields)) {
    if (app[k] === undefined) { app[k] = v; changed = true; }
  }
  for (const [k, v] of Object.entries(snapshot.topFields)) {
    if (config[k] === undefined) { config[k] = v; changed = true; }
  }
  if (!changed) return 0;
  atomicWriteJson(configPath, config);
  return toAdd.length;
}

function writeSyncState(stateFile, { appId, brand, appSecret }) {
  const salt = crypto.randomBytes(16).toString('hex');
  atomicWriteJson(stateFile, {
    version: SYNC_STATE_VERSION,
    appId,
    brand,
    salt,
    secretHmac: hmacSecret(salt, appSecret),
  }, 0o600);
  fs.chmodSync(stateFile, 0o600);
}

/**
 * Push LARK_APP_ID / LARK_APP_SECRET into lark-cli's keychain by delegating
 * to `lark-cli config init --app-secret-stdin`. The Go binary already
 * implements all the AES-256-GCM keychain writing logic; calling it
 * removes ~1000 lines of duplicate code and eliminates the risk of
 * schema drift between our copy and lark-cli's source of truth.
 *
 * Prerequisite: `lark-cli` must be on PATH — call installLarkCliBinary()
 * before this function.
 *
 * Resolution order (first non-empty wins per field):
 *   appId / appSecret:
 *     1. opts.appId / opts.appSecret
 *     2. ~/zylos/.env  (parsed via dotenv.parse, no side effects on process.env)
 *     3. process.env.LARK_APP_ID / LARK_APP_SECRET
 *   lang:
 *     1. opts.lang
 *     2. ~/zylos/.env  LARK_LANG
 *     3. process.env.LARK_LANG
 *     4. fallback 'zh'
 *
 * If appId or appSecret cannot be resolved, logs a warning and returns
 * {skipped: true, reason: 'credentials_missing'} — does NOT throw, so the
 * hook can keep going (subdirs, sub-skill install, etc.). The user can add
 * credentials to .env later and re-run the hook to complete the sync.
 *
 * `config init` is skipped when lark-cli is already configured with the
 * same appId / brand / lang and the same secret (see canSkipConfigInit).
 * When it does run, users logged in via `lark-cli auth login` for the same
 * appId are restored afterwards, and any user identity that is still lost
 * is reported with a warning (issue #112).
 *
 * Throws only if `lark-cli config init` itself fails (non-zero exit).
 * Failures while preserving users or writing the sync state only warn.
 *
 * Secret is piped via stdin so it never appears in the process listing,
 * and it is never logged. Test seams: opts.execFile, opts.configPath,
 * opts.stateFile.
 */
export function syncCredentialsToLarkCli(opts = {}) {
  let { appId, appSecret, lang, envFile = DEFAULT_ENV_FILE } = opts;
  const {
    execFile = execFileSync,
    configPath = getLarkCliConfigPath(),
    stateFile = DEFAULT_SYNC_STATE_FILE,
  } = opts;

  if (fs.existsSync(envFile)) {
    const parsed = parseDotenv(fs.readFileSync(envFile));
    appId = appId || parsed.LARK_APP_ID;
    appSecret = appSecret || parsed.LARK_APP_SECRET;
    lang = lang || parsed.LARK_LANG;
  }
  appId = appId || process.env.LARK_APP_ID;
  appSecret = appSecret || process.env.LARK_APP_SECRET;
  lang = lang || process.env.LARK_LANG || DEFAULT_LARK_LANG;

  if (!appId || !appSecret) {
    console.warn(
      `${LOG_PREFIX} LARK_APP_ID / LARK_APP_SECRET not found in ${envFile} ` +
      `or process.env; skipping lark-cli keychain sync. ` +
      `Add the variables to ${envFile} and re-run this hook (or 'zylos upgrade lark') to sync.`
    );
    return { skipped: true, reason: 'credentials_missing' };
  }

  const result = {
    appId,
    brand: LARK_BRAND,
    lang,
    configPath,
    keychainID: `appsecret:${appId}`,
    initSkipped: false,
    restoredUsers: 0,
    lostUsers: [],
  };

  const before = readLarkCliConfig(configPath);
  const beforeConfig = before.status === 'ok' ? before.data : null;
  const stateRes = readJsonFile(stateFile);
  const state = stateRes.status === 'ok' ? stateRes.data : null;

  if (canSkipConfigInit({ config: beforeConfig, state, appId, appSecret, brand: LARK_BRAND, lang })) {
    console.log(
      `${LOG_PREFIX} lark-cli already configured for this app (brand=${LARK_BRAND}, lang=${lang}); ` +
      `skipping config init`
    );
    result.initSkipped = true;
    return result;
  }

  const snapshot = snapshotPreservedState(beforeConfig, appId);

  // lark-cli saves config.json *before* probing the app against the server
  // (cmd/config/init.go runProbe), so a non-zero exit can still have wiped
  // the user list: restore in both cases, then rethrow.
  let initError = null;
  try {
    execFile('lark-cli', [
      'config', 'init',
      '--app-id', appId,
      '--app-secret-stdin',
      '--brand', LARK_BRAND,
      '--lang', lang,
    ], {
      input: appSecret + '\n',
      stdio: ['pipe', 'inherit', 'inherit'],
    });
  } catch (err) {
    initError = err;
  }

  if (snapshot) {
    try {
      result.restoredUsers = restorePreservedState(configPath, snapshot, appId);
      if (result.restoredUsers > 0) {
        console.log(`${LOG_PREFIX} restored ${result.restoredUsers} lark-cli logged-in user(s) after config init`);
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} failed to restore lark-cli user list after config init: ${err.message}`);
    }
  }

  if (initError) throw initError;

  console.log(`${LOG_PREFIX} synced App credentials to lark-cli (brand=${LARK_BRAND}, lang=${lang})`);

  try {
    writeSyncState(stateFile, { appId, brand: LARK_BRAND, appSecret });
  } catch (err) {
    console.warn(`${LOG_PREFIX} failed to record lark-cli sync state (next run will re-init): ${err.message}`);
  }

  const after = readLarkCliConfig(configPath);
  const afterKeys = new Set(
    listUsers(after.status === 'ok' ? after.data : null).map((u) => `${u.appId}\u0000${u.userOpenId}`)
  );
  result.lostUsers = listUsers(beforeConfig).filter((u) => !afterKeys.has(`${u.appId}\u0000${u.userOpenId}`));
  for (const u of result.lostUsers) {
    const why = u.appId === appId
      ? 'could not be restored'
      : `belonged to a different app (${u.appId}) than LARK_APP_ID and cannot be carried over`;
    console.warn(
      `${LOG_PREFIX} WARNING: lark-cli user identity ${u.userName || '(unnamed)'} (${u.userOpenId}) ` +
      `is no longer configured after credential sync: it ${why}. ` +
      `Re-authorize with 'lark-cli auth login' if user identity is still needed.`
    );
  }

  return result;
}
