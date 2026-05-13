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
const XC_SKILLS_SOURCE = 'https://github.com/larksuite/cli';
const SUB_SKILL_PROBE = path.join('lark-im', 'SKILL.md');
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
  console.log(`${LOG_PREFIX} installing lark-cli: npm install -g ${LARK_CLI_NPM_PACKAGE}`);
  execSync(`npm install -g ${LARK_CLI_NPM_PACKAGE}`, { stdio: 'inherit' });
  if (!commandExists('lark-cli')) {
    throw new Error(`lark-cli still not found in PATH after \`npm install -g ${LARK_CLI_NPM_PACKAGE}\``);
  }
}

/**
 * Install lark-cli's 20+ bundled Agent Skills into `<skillDir>/references/`.
 * Each sub-skill lands as its own folder (lark-im/, lark-doc/, ...).
 * Skipped if the probe file (`lark-im/SKILL.md`) already exists.
 */
export function installLarkCliSkills(skillDir) {
  if (!skillDir) {
    throw new Error('installLarkCliSkills: skillDir is required');
  }
  const bundlesDir = path.join(skillDir, 'references');
  fs.mkdirSync(bundlesDir, { recursive: true });

  const probe = path.join(bundlesDir, SUB_SKILL_PROBE);
  if (fs.existsSync(probe)) {
    console.log(`${LOG_PREFIX} lark-cli sub-skills already present, skipping`);
    return;
  }
  console.log(`${LOG_PREFIX} installing lark-cli sub-skills into ${bundlesDir}`);
  execSync(
    `npx xc-skills@latest add ${XC_SKILLS_SOURCE} --out "${bundlesDir}" -y`,
    { stdio: 'inherit' }
  );
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
 * Throws if appId or appSecret cannot be resolved, or if `lark-cli config
 * init` itself fails (non-zero exit).
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
    throw new Error(
      `LARK_APP_ID / LARK_APP_SECRET missing. ` +
      `Set them in ${envFile} (or pass {appId, appSecret} explicitly).`
    );
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
