#!/usr/bin/env node
/**
 * Post-install hook for zylos-lark
 *
 * Called by Claude after CLI installation (zylos add --json).
 * CLI handles: download, npm install, manifest, registration.
 * Claude handles: config collection, this hook, service start.
 *
 * This hook handles lark-specific setup:
 * - Create subdirectories (logs, media)
 * - Create default config.json
 * - Check for required environment variables
 */

import fs from 'fs';
import path from 'path';
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

// 3. Check environment variables
console.log('\nChecking environment variables...');
let envContent = '';
try {
  envContent = fs.readFileSync(ENV_FILE, 'utf8');
} catch (e) {}

const hasAppId = envContent.includes('LARK_APP_ID');
const hasAppSecret = envContent.includes('LARK_APP_SECRET');
const hasWebhookUrl = envContent.includes('LARK_WEBHOOK_URL');

if (!hasAppId || !hasAppSecret || !hasWebhookUrl) {
  console.log('\n[lark] Required environment variables not found in ' + ENV_FILE);
  console.log('    Please add:');
  if (!hasAppId) console.log('    LARK_APP_ID=your_app_id');
  if (!hasAppSecret) console.log('    LARK_APP_SECRET=your_app_secret');
  if (!hasWebhookUrl) console.log('    LARK_WEBHOOK_URL=https://yourdomain.com/lark/webhook');
}

// Read webhook URL for display in setup checklist
let webhookUrl = '';
if (hasWebhookUrl) {
  const match = envContent.match(/^LARK_WEBHOOK_URL=(.+)$/m);
  if (match) webhookUrl = match[1].trim();
}

// Note: PM2 service is started by Claude after this hook completes.

console.log('\n[post-install] Complete!');

const port = INITIAL_CONFIG.webhook_port || 3457;
const webhookDisplay = webhookUrl || `http://<your-host>:${port}/webhook`;
console.log('\n========================================');
console.log('  Feishu/Lark Setup Checklist');
console.log('========================================');
console.log('');
console.log('1. Add credentials to ~/zylos/.env:');
console.log('   LARK_APP_ID=your_app_id');
console.log('   LARK_APP_SECRET=your_app_secret');
console.log('   LARK_WEBHOOK_URL=https://yourdomain.com/lark/webhook');
console.log('');
console.log('2. In Feishu/Lark developer console:');
console.log('   - Feishu: open.feishu.cn/app');
console.log('   - Lark:   open.larksuite.com/app');
console.log('');
console.log('   a) Enable "Bot" capability');
console.log('   b) Subscribe to event: im.message.receive_v1');
console.log(`   c) Set Request URL: ${webhookDisplay}`);
console.log('');
console.log('3. (Optional) Event security in ~/zylos/components/lark/config.json:');
console.log('   - Verification Token: "bot": { "verification_token": "your_token" }');
console.log('   - Encrypt Key:        "bot": { "encrypt_key": "your_key" }');
console.log('   Both values are found in: Event subscriptions page in console');
console.log('');
console.log('4. Restart service: pm2 restart zylos-lark');
console.log('');
console.log('First private message to the bot will auto-bind the sender as owner.');
console.log('========================================');
