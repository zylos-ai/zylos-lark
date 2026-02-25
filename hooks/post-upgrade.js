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

    // Migration 4: Ensure owner structure
    if (!config.owner) {
      config.owner = { bound: false, user_id: '', open_id: '', name: '' };
      migrated = true;
      migrations.push('Added owner structure');
    }

    // Migration 5: Migrate legacy whitelist → dmPolicy/dmAllowFrom
    if (config.whitelist && !config.dmPolicy) {
      // Derive dmPolicy from legacy whitelist
      const wlEnabled = config.whitelist.private_enabled ?? config.whitelist.enabled ?? false;
      config.dmPolicy = wlEnabled ? 'allowlist' : 'open';
      // Merge users into dmAllowFrom
      const legacyUsers = [
        ...(config.whitelist.private_users || []),
        ...(config.whitelist.group_users || [])
      ];
      if (legacyUsers.length) {
        config.dmAllowFrom = [...(config.dmAllowFrom || [])];
        for (const u of legacyUsers) {
          if (!config.dmAllowFrom.includes(u)) config.dmAllowFrom.push(u);
        }
      }
      migrations.push(`Migrated whitelist → dmPolicy=${config.dmPolicy}, ${(config.dmAllowFrom || []).length} users in dmAllowFrom`);
      config._legacy_whitelist = config.whitelist;
      delete config.whitelist;
      migrated = true;
    }
    // Ensure dmPolicy/dmAllowFrom defaults
    if (config.dmPolicy === undefined) {
      config.dmPolicy = config.whitelist ? 'open' : 'owner';
      migrated = true;
      migrations.push(`Added dmPolicy=${config.dmPolicy}`);
    }
    if (config.dmAllowFrom === undefined) {
      config.dmAllowFrom = [];
      migrated = true;
      migrations.push('Added dmAllowFrom');
    }

    // Migration 6: Migrate legacy allowed_groups/smart_groups → groups map + groupPolicy
    if (!config.groups && (Array.isArray(config.allowed_groups) || Array.isArray(config.smart_groups))) {
      const groups = {};

      if (Array.isArray(config.allowed_groups)) {
        for (const g of config.allowed_groups) {
          if (g.chat_id) {
            groups[g.chat_id] = {
              name: g.name || '',
              mode: 'mention',
              requireMention: true,
            };
          }
        }
      }

      if (Array.isArray(config.smart_groups)) {
        for (const g of config.smart_groups) {
          if (g.chat_id) {
            groups[g.chat_id] = {
              name: g.name || '',
              mode: 'smart',
              requireMention: false,
            };
          }
        }
      }

      config.groups = groups;

      if (config.group_whitelist?.enabled === false) {
        config.groupPolicy = 'open';
      } else {
        config.groupPolicy = 'allowlist';
      }

      if (config.allowed_groups?.length > 0) {
        config._legacy_allowed_groups = config.allowed_groups;
      }
      if (config.smart_groups?.length > 0) {
        config._legacy_smart_groups = config.smart_groups;
      }

      delete config.allowed_groups;
      delete config.smart_groups;
      delete config.group_whitelist;

      migrated = true;
      migrations.push(`Migrated ${Object.keys(groups).length} groups to new groups map format`);
    }

    // Ensure groups and groupPolicy exist
    if (config.groups === undefined) {
      config.groups = {};
      migrated = true;
      migrations.push('Added groups map');
    }
    if (config.groupPolicy === undefined) {
      if (config.group_whitelist !== undefined) {
        config.groupPolicy = config.group_whitelist?.enabled !== false ? 'allowlist' : 'open';
        migrations.push(`Derived groupPolicy=${config.groupPolicy} from group_whitelist`);
        config._legacy_group_whitelist = config.group_whitelist;
        delete config.group_whitelist;
      } else {
        config.groupPolicy = 'allowlist';
        migrations.push('Added groupPolicy (default: allowlist)');
      }
      migrated = true;
    }

    // Migration 7: Ensure proxy settings
    if (!config.proxy) {
      config.proxy = { enabled: false, host: '', port: 0 };
      migrated = true;
      migrations.push('Added proxy settings');
    }

    // Migration 8: Ensure message settings
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
      if (config.message.max_length !== undefined) {
        delete config.message.max_length;
        migrated = true;
        migrations.push('Removed unused message.max_length');
      }
    }

    // Migration 9: Migrate remaining legacy group config
    if ((Array.isArray(config.allowed_groups) && config.allowed_groups.length > 0) ||
        (Array.isArray(config.smart_groups) && config.smart_groups.length > 0) ||
        (config.group_whitelist !== undefined && !config.groupPolicy)) {

      if (!config.groups) config.groups = {};

      if (Array.isArray(config.allowed_groups) && config.allowed_groups.length > 0) {
        for (const g of config.allowed_groups) {
          if (g.chat_id && !config.groups[g.chat_id]) {
            config.groups[g.chat_id] = {
              name: g.name || 'unnamed',
              mode: 'mention',
              requireMention: true,
              added_at: g.added_at || new Date().toISOString()
            };
            migrations.push(`Migrated allowed_group ${g.chat_id} → groups[mention]`);
          }
        }
        config._legacy_allowed_groups = config.allowed_groups;
        delete config.allowed_groups;
        migrated = true;
      }

      if (Array.isArray(config.smart_groups) && config.smart_groups.length > 0) {
        for (const g of config.smart_groups) {
          if (g.chat_id) {
            config.groups[g.chat_id] = {
              name: g.name || config.groups[g.chat_id]?.name || 'unnamed',
              mode: 'smart',
              requireMention: false,
              added_at: g.added_at || config.groups[g.chat_id]?.added_at || new Date().toISOString()
            };
            migrations.push(`Migrated smart_group ${g.chat_id} → groups[smart]`);
          }
        }
        config._legacy_smart_groups = config.smart_groups;
        delete config.smart_groups;
        migrated = true;
      }

      if (config.group_whitelist !== undefined && !config.groupPolicy) {
        config.groupPolicy = config.group_whitelist?.enabled !== false ? 'allowlist' : 'open';
        migrations.push(`Migrated group_whitelist → groupPolicy=${config.groupPolicy}`);
        config._legacy_group_whitelist = config.group_whitelist;
        delete config.group_whitelist;
        migrated = true;
      }
    }

    // Ensure groupPolicy exists
    if (!config.groupPolicy) {
      config.groupPolicy = 'allowlist';
      migrated = true;
      migrations.push('Added groupPolicy=allowlist');
    }

    // Ensure groups map exists
    if (!config.groups) {
      config.groups = {};
      migrated = true;
      migrations.push('Added groups map');
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
