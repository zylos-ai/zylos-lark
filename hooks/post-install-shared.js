#!/usr/bin/env node
/**
 * Shared helpers for post-install and post-upgrade hooks.
 *
 * Three idempotent steps that integrate lark-cli into zylos-lark:
 *   1. installLarkCliBinary()           - probe + `npm install -g @larksuite/cli`
 *   2. installLarkCliSkills(skillDir)   - probe + `npx xc-skills add larksuite/cli`
 *                                          (populates skillDir/references/)
 *   3. syncCredentialsToLarkCli(opts)   - read ~/zylos/.env, call saveLarkCliConfig
 *                                          (writes lark-cli config + keychain)
 *
 * Each function throws on failure; the caller decides whether to abort.
 * See docs/INTEGRATE-LARK-CLI.md (§4.2, §4.6.1) for the design rationale.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { parse as parseDotenv } from 'dotenv';
import { saveLarkCliConfig } from '../src/lib/config-init-store.js';

const LARK_CLI_NPM_PACKAGE = '@larksuite/cli';
const XC_SKILLS_SOURCE = 'https://github.com/larksuite/cli';
const SUB_SKILL_PROBE = path.join('lark-im', 'SKILL.md');
const LARK_BRAND = 'lark';
const LARK_LANG = 'zh';
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
 * Push LARK_APP_ID / LARK_APP_SECRET into lark-cli's keychain so that
 * `--as bot` calls work out of the box (no separate `lark-cli config init`).
 *
 * Resolution order for credentials:
 *   1. Explicit `opts.appId` / `opts.appSecret`
 *   2. `~/zylos/.env` (parsed via dotenv.parse, no side effects on process.env)
 *   3. process.env.LARK_APP_ID / LARK_APP_SECRET
 *
 * Throws if both appId and appSecret cannot be resolved.
 *
 * Writes via `saveLarkCliConfig` (../src/lib/config-init-store.js) — same
 * schema and AES-256-GCM keychain layout as the Go lark-cli, so the
 * binary picks up the secret on its next call.
 */
export function syncCredentialsToLarkCli(opts = {}) {
  let { appId, appSecret, envFile = DEFAULT_ENV_FILE } = opts;

  if ((!appId || !appSecret) && fs.existsSync(envFile)) {
    const parsed = parseDotenv(fs.readFileSync(envFile));
    appId = appId || parsed.LARK_APP_ID;
    appSecret = appSecret || parsed.LARK_APP_SECRET;
  }
  appId = appId || process.env.LARK_APP_ID;
  appSecret = appSecret || process.env.LARK_APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error(
      `LARK_APP_ID / LARK_APP_SECRET missing. ` +
      `Set them in ${envFile} (or pass {appId, appSecret} explicitly).`
    );
  }

  const result = saveLarkCliConfig({
    appId,
    appSecret,
    brand: LARK_BRAND,
    lang: LARK_LANG,
  });
  console.log(`${LOG_PREFIX} synced App credentials to lark-cli`);
  console.log(`${LOG_PREFIX}   config:   ${result.configPath}`);
  console.log(`${LOG_PREFIX}   keychain: ${result.keychainID}`);
  return result;
}
