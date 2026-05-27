#!/usr/bin/env node
/**
 * Post-install hook for zylos-lark
 *
 * Called during installation (both terminal and JSON/Claude modes).
 * Terminal mode (stdio: inherit): runs interactive prompts for optional config.
 * JSON mode (stdio: pipe): runs silently, skips interactive prompts.
 *
 * This hook handles lark-specific setup:
 * - Create subdirectories (logs, media)
 * - Create default config.json
 * - Install lark-cli binary (npm install -g @larksuite/cli) if missing
 * - Install 20+ lark-cli sub-skills into references/ if missing
 * - Sync App credentials from ~/zylos/.env into lark-cli's keychain
 * - Prompt for verification token (terminal mode only, required)
 *
 * The three lark-cli steps are idempotent and abort the install on failure
 * (see docs/INTEGRATE-LARK-CLI.md §4.2, §4.4).
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import {
  installLarkCliBinary,
  installLarkCliSkills,
  syncCredentialsToLarkCli,
} from './post-install-shared.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_DIR = path.resolve(__dirname, '..');

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/lark');

// Minimal initial config - full defaults are in src/lib/config.js
const INITIAL_CONFIG = {
  enabled: true,
  webhook_port: 3457,
  message: { useMarkdownCard: true }
};

const isInteractive = process.stdin.isTTY === true;

/**
 * Prompt user for input (only works in terminal mode).
 */
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

console.log('[post-install] Running lark-specific setup...\n');

// 1. Create subdirectories
console.log('Creating subdirectories...');
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'media'), { recursive: true });
console.log('  - logs/');
console.log('  - media/');

// 2. Create default config if not exists
const configPath = path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(configPath)) {
  console.log('\nCreating default config.json...');
  fs.writeFileSync(configPath, JSON.stringify(INITIAL_CONFIG, null, 2));
  console.log('  - config.json created');
} else {
  console.log('\nConfig already exists, skipping.');
}

// 3. Ensure lark-cli binary is installed
console.log('\nEnsuring lark-cli binary is installed...');
installLarkCliBinary();

// 4. Ensure lark-cli sub-skills are present under references/
console.log('\nEnsuring lark-cli sub-skills are installed...');
installLarkCliSkills(SKILL_DIR);

// 5. Sync App ID / Secret from ~/zylos/.env into lark-cli's keychain.
//    Uses src/lib/config-init-store.js — interoperable with the Go
//    lark-cli binary, so subsequent `--as bot` calls just work.
console.log('\nSyncing App credentials to lark-cli keychain...');
syncCredentialsToLarkCli();

// 6. Prompt for verification token (terminal mode only)
if (isInteractive) {
  console.log('\nVerification Token (REQUIRED for webhook security):');
  const token = await ask('  Verification Token (from Event Subscriptions page): ');
  if (token) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.bot = config.bot || {};
    config.bot.verification_token = token;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('  ✓ Verification token saved to config.json');
  } else {
    console.log('  WARNING: Verification token is required for the service to start.');
    console.log('  You must set bot.verification_token in config.json before starting.');
  }

  const encryptKey = await ask('  Encrypt Key (optional, for payload encryption) [press Enter to skip]: ');
  if (encryptKey) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.bot = config.bot || {};
    config.bot.encrypt_key = encryptKey;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('  ✓ Encrypt key saved to config.json');
  }
}

// Note: PM2 service is started by Claude after this hook completes.

console.log('\n[post-install] Complete!');

// Read domain from zylos config for webhook URL display
let webhookUrl = 'https://<your-domain>/lark/webhook';
try {
  const zylosConfig = JSON.parse(fs.readFileSync(path.join(HOME, 'zylos/.zylos/config.json'), 'utf8'));
  if (zylosConfig.domain) {
    const protocol = zylosConfig.protocol || 'https';
    webhookUrl = `${protocol}://${zylosConfig.domain}/lark/webhook`;
  }
} catch (e) {}

console.log('\n========================================');
console.log('  Feishu/Lark Setup — Remaining Steps');
console.log('========================================');
console.log('');
console.log('After the service starts, go to the developer console:');
console.log('  - Feishu: open.feishu.cn/app');
console.log('  - Lark:   open.larksuite.com/app');
console.log('');
console.log('1. Enable "Bot" capability');
console.log('2. Subscribe to event: im.message.receive_v1');
console.log(`3. Set Request URL: ${webhookUrl}`);
console.log('');
console.log('First private message to the bot will auto-bind the sender as owner.');
console.log('========================================');
