#!/usr/bin/env node
/**
 * Shared helpers for post-install and post-upgrade hooks.
 *
 * Three idempotent steps that integrate lark-cli into zylos-lark:
 *   1. installLarkCliBinary()           - probe + `npm install -g @larksuite/cli`
 *   2. installLarkCliSkills(skillDir)   - probe + `npx xc-skills add larksuite/cli`
 *                                          (populates skillDir/references/)
 *   3. syncCredentialsToLarkCli(opts)   - read ~/zylos/.env, delegate to
 *                                          `lark-cli config init --app-secret-stdin`
 *                                          (writes lark-cli config + keychain)
 *
 * Each function throws on failure; the caller decides whether to abort.
 * See docs/INTEGRATE-LARK-CLI.md (§4.2, §4.6.1) for the design rationale.
 */

import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
import { parse as parseDotenv } from 'dotenv';

const LARK_CLI_NPM_PACKAGE = '@larksuite/cli';
// Single source-of-truth for the lark-cli upstream release. Used for both
// the npm package version (no prefix) and the git tag ref (prefixed 'v').
const LARK_CLI_VERSION = '1.0.41';
const XC_SKILLS_SOURCE = 'https://github.com/larksuite/cli';
// Canonical list of bundled lark-cli sub-skills declared in SKILL.md.
// Checked exhaustively on every run to catch partial-install / manual
// deletion scenarios where a single-probe check would have skipped.
const EXPECTED_SUB_SKILLS = Object.freeze([
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

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the `lark-cli` binary is on PATH. Installs `@larksuite/cli`
 * globally if missing. Idempotent.
 */
export function installLarkCliBinary() {
  if (commandExists('lark-cli')) {
    console.log(`${LOG_PREFIX} lark-cli already on PATH, skipping binary install`);
    return;
  }
  console.log(`${LOG_PREFIX} installing lark-cli: npm install -g ${LARK_CLI_NPM_PACKAGE}@${LARK_CLI_VERSION}`);
  execSync(`npm install -g ${LARK_CLI_NPM_PACKAGE}@${LARK_CLI_VERSION}`, { stdio: 'inherit' });
  if (!commandExists('lark-cli')) {
    throw new Error(`lark-cli still not found in PATH after \`npm install -g ${LARK_CLI_NPM_PACKAGE}@${LARK_CLI_VERSION}\``);
  }
}

/**
 * Install lark-cli's bundled Agent Skills into `<skillDir>/references/`.
 * Each sub-skill lands as its own folder (lark-im/, lark-doc/, ...).
 *
 * Audits every module in EXPECTED_SUB_SKILLS — rerunning the install
 * whenever any are missing — so partial-install state (an aborted prior
 * run, or manually removed folders) gets repaired instead of silently
 * skipped on the basis of a single probe file.
 */
export function installLarkCliSkills(skillDir) {
  if (!skillDir) {
    throw new Error('installLarkCliSkills: skillDir is required');
  }
  const bundlesDir = path.join(skillDir, 'references');
  fs.mkdirSync(bundlesDir, { recursive: true });

  const findMissing = () =>
    EXPECTED_SUB_SKILLS.filter(
      (name) => !fs.existsSync(path.join(bundlesDir, name, 'SKILL.md'))
    );

  const missing = findMissing();
  if (missing.length === 0) {
    console.log(
      `${LOG_PREFIX} all ${EXPECTED_SUB_SKILLS.length} lark-cli sub-skills present, skipping`
    );
    return;
  }

  console.log(
    `${LOG_PREFIX} ${missing.length}/${EXPECTED_SUB_SKILLS.length} sub-skill(s) missing (${missing.join(', ')}), repairing into ${bundlesDir}`
  );
  execSync(
    `npx xc-skills@latest add ${XC_SKILLS_SOURCE}#v${LARK_CLI_VERSION} --out "${bundlesDir}" -y`,
    { stdio: 'inherit' }
  );

  const stillMissing = findMissing();
  if (stillMissing.length > 0) {
    throw new Error(
      `installLarkCliSkills: still missing after install: ${stillMissing.join(', ')}`
    );
  }
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
 * Throws only if `lark-cli config init` itself fails (non-zero exit).
 *
 * Secret is piped via stdin so it never appears in the process listing.
 */
export function syncCredentialsToLarkCli(opts = {}) {
  let { appId, appSecret, lang, envFile = DEFAULT_ENV_FILE } = opts;

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
    // Soft-fail: log and skip credential sync without aborting the hook.
    // Rationale: a missing credential at install/upgrade time is not always
    // fatal — the user may add them to .env later and re-trigger sync. The
    // hook should not block the rest of the install (subdir creation,
    // sub-skill setup, etc.). Any sub-skill needing lark-cli will surface
    // its own credential error at call time.
    console.warn(
      `${LOG_PREFIX} LARK_APP_ID / LARK_APP_SECRET not found in ${envFile} ` +
      `or process.env; skipping lark-cli keychain sync. ` +
      `Add the variables to ${envFile} and re-run this hook (or 'zylos upgrade lark') to sync.`
    );
    return { skipped: true, reason: 'credentials_missing' };
  }

  execFileSync('lark-cli', [
    'config', 'init',
    '--app-id', appId,
    '--app-secret-stdin',
    '--brand', LARK_BRAND,
    '--lang', lang,
  ], {
    input: appSecret + '\n',
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  console.log(`${LOG_PREFIX} synced App credentials to lark-cli (brand=${LARK_BRAND}, lang=${lang})`);

  return {
    appId,
    brand: LARK_BRAND,
    lang,
    configPath: path.join(process.env.HOME || '', '.lark-cli', 'config.json'),
    keychainID: `appsecret:${appId}`,
  };
}
