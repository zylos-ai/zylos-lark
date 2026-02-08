#!/usr/bin/env node
/**
 * Post-install hook for zylos-lark
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = process.env.HOME;
const SKILL_DIR = path.dirname(__dirname);
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

if (!hasAppId || !hasAppSecret) {
  console.log('\n[lark] Required environment variables not found in ' + ENV_FILE);
  console.log('    Please add:');
  if (!hasAppId) console.log('    LARK_APP_ID=your_app_id');
  if (!hasAppSecret) console.log('    LARK_APP_SECRET=your_app_secret');
}

// 4. Configure PM2 with ecosystem.config.cjs
console.log('\nConfiguring PM2 service...');
const ecosystemPath = path.join(SKILL_DIR, 'ecosystem.config.cjs');
if (fs.existsSync(ecosystemPath)) {
  try {
    execSync('pm2 delete zylos-lark 2>/dev/null || true', { stdio: 'pipe' });
    execSync(`pm2 start "${ecosystemPath}"`, { stdio: 'inherit' });
    execSync('pm2 save', { stdio: 'pipe' });
    console.log('  - Service configured');
  } catch (err) {
    console.error('  - PM2 configuration failed:', err.message);
  }
}

console.log('\n[post-install] Complete!');

const port = INITIAL_CONFIG.webhook_port || 3457;
console.log('\n========================================');
console.log('  Feishu/Lark Setup Checklist');
console.log('========================================');
console.log('');
console.log('1. Add credentials to ~/zylos/.env:');
console.log('   LARK_APP_ID=your_app_id');
console.log('   LARK_APP_SECRET=your_app_secret');
console.log('');
console.log('2. In Feishu Open Platform (open.feishu.cn/app):');
console.log('   a) Enable "Bot" capability (添加应用能力 → 机器人)');
console.log('   b) Subscribe to event: im.message.receive_v1');
console.log(`   c) Set Request URL: http://<your-host>:${port}/webhook`);
console.log('');
console.log('3. (Optional) If you enabled event encryption:');
console.log('   Add "encrypt_key" to the "bot" section in ~/zylos/components/lark/config.json:');
console.log('   "bot": { "encrypt_key": "your_key_from_feishu" }');
console.log('');
console.log('4. Restart service: pm2 restart zylos-lark');
console.log('');
console.log('First private message to the bot will auto-bind the sender as owner.');
console.log('========================================');
