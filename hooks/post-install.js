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
 * - Check for environment variables (informational)
 * - Prompt for verification token (terminal mode only, optional)
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/lark');
const ENV_FILE = path.join(HOME, 'zylos/.env');

// Minimal initial config - full defaults are in src/lib/config.js
const INITIAL_CONFIG = {
  enabled: true,
  webhook_port: 3457
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

// 3. Check environment variables (informational)
console.log('\nChecking environment variables...');
let envContent = '';
try {
  envContent = fs.readFileSync(ENV_FILE, 'utf8');
} catch (e) {}

const hasAppId = envContent.includes('LARK_APP_ID');
const hasAppSecret = envContent.includes('LARK_APP_SECRET');

if (!hasAppId || !hasAppSecret) {
  console.log('  LARK_APP_ID and/or LARK_APP_SECRET not yet in .env.');
} else {
  console.log('  Credentials found.');
}

// 4. Prompt for verification token (terminal mode only)
if (isInteractive) {
  const answer = await ask('\nConfigure verification token? (optional, enhances security) [y/N]: ');
  if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
    const token = await ask('  Verification Token (from Event Subscriptions page): ');
    if (token) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config.bot = config.bot || {};
      config.bot.verification_token = token;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('  ✓ Verification token saved to config.json');
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
