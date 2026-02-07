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

// 4. Configure PM2 with ecosystem.config.js
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
console.log('\nNext steps:');
console.log('1. Add LARK_APP_ID and LARK_APP_SECRET to ~/zylos/.env');
console.log('2. Configure webhook URL in Lark app settings');
console.log('3. Update ~/zylos/components/lark/config.json if needed');
