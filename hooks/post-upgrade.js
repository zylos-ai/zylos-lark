#!/usr/bin/env node
/**
 * Post-upgrade hook for zylos-lark
 *
 * Called by Claude after CLI upgrade completes (zylos upgrade --json).
 * CLI handles: stop service, backup, file sync, npm install, manifest.
 *
 * This hook handles component-specific migrations:
 * - Config schema migrations
 * - Data format updates
 *
 * Note: Service restart is handled by Claude after this hook.
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/lark');
const configPath = path.join(DATA_DIR, 'config.json');

console.log('[post-upgrade] Running lark-specific migrations...\n');

// Config migrations
if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let migrated = false;
    const migrations = [];

    // Migration 1: Ensure enabled field
    if (config.enabled === undefined) {
      config.enabled = true;
      migrated = true;
      migrations.push('Added enabled field');
    }

    // Migration 2: Ensure webhook_port
    if (config.webhook_port === undefined) {
      config.webhook_port = 3457;
      migrated = true;
      migrations.push('Added webhook_port');
    }

    // Migration 3: Ensure bot settings
    if (!config.bot) {
      config.bot = { encrypt_key: '' };
      migrated = true;
      migrations.push('Added bot settings');
    }
    // Clean up removed field
    if (config.bot.verification_token !== undefined) {
      delete config.bot.verification_token;
      migrated = true;
      migrations.push('Removed unused bot.verification_token');
    }

    // Migration 4: Ensure owner structure
    if (!config.owner) {
      config.owner = { bound: false, user_id: '', open_id: '', name: '' };
      migrated = true;
      migrations.push('Added owner structure');
    }

    // Migration 5: Ensure whitelist structure
    if (!config.whitelist) {
      config.whitelist = { enabled: false, private_users: [], group_users: [] };
      migrated = true;
      migrations.push('Added whitelist structure');
    } else {
      if (!Array.isArray(config.whitelist.private_users)) {
        config.whitelist.private_users = [];
        migrated = true;
        migrations.push('Added whitelist.private_users');
      }
      if (!Array.isArray(config.whitelist.group_users)) {
        config.whitelist.group_users = [];
        migrated = true;
        migrations.push('Added whitelist.group_users');
      }
    }

    // Migration 6: Ensure allowed_groups array
    if (config.allowed_groups === undefined) {
      config.allowed_groups = [];
      migrated = true;
      migrations.push('Added allowed_groups array');
    }

    // Migration 7: Ensure smart_groups array
    if (config.smart_groups === undefined) {
      config.smart_groups = [];
      migrated = true;
      migrations.push('Added smart_groups array');
    }

    // Migration 8: Ensure proxy settings
    if (!config.proxy) {
      config.proxy = { enabled: false, host: '', port: 0 };
      migrated = true;
      migrations.push('Added proxy settings');
    }

    // Migration 9: Ensure message settings
    if (!config.message) {
      config.message = { context_messages: 10 };
      migrated = true;
      migrations.push('Added message settings');
    } else {
      if (config.message.context_messages === undefined) {
        config.message.context_messages = 10;
        migrated = true;
        migrations.push('Added message.context_messages');
      }
      // Clean up removed field
      if (config.message.max_length !== undefined) {
        delete config.message.max_length;
        migrated = true;
        migrations.push('Removed unused message.max_length');
      }
    }

    // Save if migrated
    if (migrated) {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('Config migrations applied:');
      migrations.forEach(m => console.log('  - ' + m));
    } else {
      console.log('No config migrations needed.');
    }
  } catch (err) {
    console.error('Config migration failed:', err.message);
    process.exit(1);
  }
} else {
  console.log('No config file found, skipping migrations.');
}

console.log('\n[post-upgrade] Complete!');
