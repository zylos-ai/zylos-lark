#!/usr/bin/env node
/**
 * zylos-lark admin CLI
 * Manage lark bot configuration
 *
 * Usage: node admin.js <command> [args]
 */

import { loadConfig, saveConfig } from './lib/config.js';

// ============================================================
// Helper: get the groups map (new format) or derive from legacy
// ============================================================
function getGroupsMap(config) {
  return config.groups || {};
}

// Commands
const commands = {
  'show': () => {
    const config = loadConfig();
    console.log(JSON.stringify(config, null, 2));
  },

  'list-groups': () => {
    const config = loadConfig();
    const groups = getGroupsMap(config);
    const entries = Object.entries(groups);

    if (entries.length === 0) {
      // Fall back to legacy display
      const allowed = config.allowed_groups || [];
      const smart = config.smart_groups || [];
      if (allowed.length === 0 && smart.length === 0) {
        console.log('No groups configured');
        return;
      }
      if (allowed.length > 0) {
        console.log('Allowed Groups (legacy, respond to @mentions):');
        allowed.forEach(g => {
          console.log(`  ${g.chat_id} - ${g.name} (added: ${g.added_at || 'unknown'})`);
        });
      }
      if (smart.length > 0) {
        console.log('Smart Groups (legacy, receive all messages):');
        smart.forEach(g => {
          console.log(`  ${g.chat_id} - ${g.name} (added: ${g.added_at || 'unknown'})`);
        });
      }
      return;
    }

    console.log(`Group Policy: ${config.groupPolicy || 'allowlist'}`);
    console.log(`\nConfigured Groups (${entries.length}):`);
    for (const [chatId, cfg] of entries) {
      const mode = cfg.mode || (cfg.requireMention === false ? 'smart' : 'mention');
      const allowFrom = cfg.allowFrom?.length ? ` allowFrom: [${cfg.allowFrom.join(', ')}]` : '';
      const historyLimit = cfg.historyLimit ? ` history: ${cfg.historyLimit}` : '';
      console.log(`  ${chatId} - ${cfg.name || 'unnamed'} [${mode}]${allowFrom}${historyLimit}`);
    }
  },

  // Backward-compatible aliases
  'list-allowed-groups': () => commands['list-groups'](),
  'list-smart-groups': () => commands['list-groups'](),

  'add-group': (chatId, name, mode = 'mention') => {
    if (!chatId || !name) {
      console.error('Usage: admin.js add-group <chat_id> <name> [mode=mention|smart]');
      process.exit(1);
    }
    if (!['mention', 'smart'].includes(mode)) {
      console.error('Mode must be "mention" or "smart"');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.groups) config.groups = {};

    if (config.groups[chatId]) {
      console.log(`Group ${chatId} already configured, updating mode to ${mode}`);
      config.groups[chatId].mode = mode;
      config.groups[chatId].requireMention = mode === 'mention';
    } else {
      config.groups[chatId] = {
        name,
        mode,
        requireMention: mode === 'mention',
        added_at: new Date().toISOString()
      };
    }
    saveConfig(config);
    console.log(`Added group: ${chatId} (${name}) [${mode}]`);
    console.log('Run: pm2 restart zylos-lark');
  },

  // Backward-compatible aliases
  'add-allowed-group': (chatId, name) => commands['add-group'](chatId, name, 'mention'),
  'add-smart-group': (chatId, name) => commands['add-group'](chatId, name, 'smart'),

  'remove-group': (chatId) => {
    if (!chatId) {
      console.error('Usage: admin.js remove-group <chat_id>');
      process.exit(1);
    }
    const config = loadConfig();

    let removed = false;

    if (config.groups?.[chatId]) {
      const name = config.groups[chatId].name;
      delete config.groups[chatId];
      removed = true;
      console.log(`Removed group: ${chatId} (${name})`);
    }

    if (config.allowed_groups) {
      const idx = config.allowed_groups.findIndex(g => String(g.chat_id) === String(chatId));
      if (idx !== -1) {
        config.allowed_groups.splice(idx, 1);
        removed = true;
      }
    }
    if (config.smart_groups) {
      const idx = config.smart_groups.findIndex(g => String(g.chat_id) === String(chatId));
      if (idx !== -1) {
        config.smart_groups.splice(idx, 1);
        removed = true;
      }
    }

    if (!removed) {
      console.log(`Group ${chatId} not found`);
      return;
    }

    saveConfig(config);
    console.log('Run: pm2 restart zylos-lark');
  },

  // Backward-compatible aliases
  'remove-allowed-group': (chatId) => commands['remove-group'](chatId),
  'remove-smart-group': (chatId) => commands['remove-group'](chatId),

  'set-group-policy': (policy) => {
    if (!['open', 'allowlist', 'disabled'].includes(policy)) {
      console.error('Usage: admin.js set-group-policy <open|allowlist|disabled>');
      process.exit(1);
    }
    const config = loadConfig();
    config.groupPolicy = policy;
    saveConfig(config);
    console.log(`Group policy set to: ${policy}`);
    console.log('Run: pm2 restart zylos-lark');
  },

  'set-group-allowfrom': (chatId, ...userIds) => {
    if (!chatId || userIds.length === 0) {
      console.error('Usage: admin.js set-group-allowfrom <chat_id> <user_id1> [user_id2] ...');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.groups?.[chatId]) {
      console.error(`Group ${chatId} not configured. Add it first with add-group.`);
      process.exit(1);
    }
    config.groups[chatId].allowFrom = userIds;
    saveConfig(config);
    console.log(`Set allowFrom for ${chatId}: [${userIds.join(', ')}]`);
    console.log('Run: pm2 restart zylos-lark');
  },

  'set-group-history-limit': (chatId, limit) => {
    if (!chatId || !limit) {
      console.error('Usage: admin.js set-group-history-limit <chat_id> <limit>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.groups?.[chatId]) {
      console.error(`Group ${chatId} not configured. Add it first with add-group.`);
      process.exit(1);
    }
    config.groups[chatId].historyLimit = parseInt(limit, 10);
    saveConfig(config);
    console.log(`Set historyLimit for ${chatId}: ${limit}`);
    console.log('Run: pm2 restart zylos-lark');
  },

  'list-whitelist': () => {
    const config = loadConfig();
    const wl = config.whitelist || { enabled: false, private_users: [], group_users: [] };
    console.log(`Whitelist (${wl.enabled ? 'enabled' : 'disabled'}):`);
    console.log('  Private users:', wl.private_users?.length ? wl.private_users.join(', ') : 'none');
    console.log('  Group users:', wl.group_users?.length ? wl.group_users.join(', ') : 'none');
  },

  'add-whitelist': (userId) => {
    if (!userId) {
      console.error('Usage: admin.js add-whitelist <user_id_or_open_id>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.whitelist) {
      config.whitelist = { enabled: false, private_users: [], group_users: [] };
    }
    if (!Array.isArray(config.whitelist.private_users)) {
      config.whitelist.private_users = [];
    }
    if (!Array.isArray(config.whitelist.group_users)) {
      config.whitelist.group_users = [];
    }

    if (!config.whitelist.private_users.includes(userId)) {
      config.whitelist.private_users.push(userId);
    }
    if (!config.whitelist.group_users.includes(userId)) {
      config.whitelist.group_users.push(userId);
    }
    saveConfig(config);
    console.log(`Added ${userId} to whitelist (private + group)`);
    if (!config.whitelist.enabled) {
      console.log('Note: Whitelist is currently disabled (all users allowed).');
      console.log('To enable: edit config.json and set whitelist.enabled = true');
    }
    console.log('Run: pm2 restart zylos-lark');
  },

  'remove-whitelist': (userId) => {
    if (!userId) {
      console.error('Usage: admin.js remove-whitelist <user_id_or_open_id>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.whitelist) {
      console.log('No whitelist configured');
      return;
    }

    let removed = false;
    const piIdx = (config.whitelist.private_users || []).indexOf(userId);
    if (piIdx !== -1) {
      config.whitelist.private_users.splice(piIdx, 1);
      removed = true;
    }
    const giIdx = (config.whitelist.group_users || []).indexOf(userId);
    if (giIdx !== -1) {
      config.whitelist.group_users.splice(giIdx, 1);
      removed = true;
    }

    if (removed) {
      saveConfig(config);
      console.log(`Removed ${userId} from whitelist`);
    } else {
      console.log(`${userId} not found in whitelist`);
    }
  },

  'enable-whitelist': () => {
    const config = loadConfig();
    if (!config.whitelist) {
      config.whitelist = { enabled: true, private_users: [], group_users: [] };
    } else {
      config.whitelist.enabled = true;
    }
    saveConfig(config);
    console.log('Whitelist enabled. Only owner + whitelisted users can interact.');
    console.log('Run: pm2 restart zylos-lark');
  },

  'disable-whitelist': () => {
    const config = loadConfig();
    if (config.whitelist) {
      config.whitelist.enabled = false;
    }
    saveConfig(config);
    console.log('Whitelist disabled. All users can interact.');
    console.log('Run: pm2 restart zylos-lark');
  },

  // Legacy commands mapped to new group policy
  'enable-group-whitelist': () => commands['set-group-policy']('allowlist'),
  'disable-group-whitelist': () => commands['set-group-policy']('open'),

  'show-owner': () => {
    const config = loadConfig();
    const owner = config.owner || {};
    if (owner.bound) {
      console.log(`Owner: ${owner.name || 'unknown'}`);
      console.log(`  user_id: ${owner.user_id}`);
      console.log(`  open_id: ${owner.open_id}`);
    } else {
      console.log('No owner bound (first private chat user will become owner)');
    }
  },

  'migrate-groups': () => {
    const config = loadConfig();
    const result = migrateGroupConfig(config);
    if (result.migrated) {
      saveConfig(config);
      console.log('Group config migrated:');
      result.migrations.forEach(m => console.log('  - ' + m));
    } else {
      console.log('No group migration needed.');
    }
  },

  'help': () => {
    console.log(`
zylos-lark admin CLI

Commands:
  show                                Show full config

  Group Management:
  list-groups                         List all configured groups
  add-group <chat_id> <name> [mode]   Add a group (mode: mention|smart)
  remove-group <chat_id>              Remove a group
  set-group-policy <policy>           Set group policy (open|allowlist|disabled)
  set-group-allowfrom <chat_id> <ids> Set per-group allowed senders
  set-group-history-limit <id> <n>    Set per-group history message limit
  migrate-groups                      Migrate legacy group config to new format

  Legacy (backward-compatible aliases):
  list-allowed-groups                 → list-groups
  add-allowed-group <id> <name>       → add-group <id> <name> mention
  add-smart-group <id> <name>         → add-group <id> <name> smart
  remove-allowed-group <id>           → remove-group
  remove-smart-group <id>             → remove-group
  enable-group-whitelist              → set-group-policy allowlist
  disable-group-whitelist             → set-group-policy open

  Whitelist (access control):
  list-whitelist                      List whitelist entries
  add-whitelist <user_id_or_open_id>  Add to whitelist
  remove-whitelist <id>               Remove from whitelist
  enable-whitelist                    Enable whitelist filtering
  disable-whitelist                   Disable whitelist (allow all)

  show-owner                          Show current owner

Note: Owner can always @mention bot in any group regardless of policy.

After changes, restart bot: pm2 restart zylos-lark
`);
  }
};

/**
 * Migrate legacy allowed_groups/smart_groups to new groups map format.
 * Preserves old fields as _legacy_* backup.
 */
function migrateGroupConfig(config) {
  const migrations = [];
  let migrated = false;

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
        migrations.push(`Migrated allowed_group ${g.chat_id} (${g.name}) → groups[mention]`);
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
        migrations.push(`Migrated smart_group ${g.chat_id} (${g.name}) → groups[smart]`);
      }
    }
    config._legacy_smart_groups = config.smart_groups;
    delete config.smart_groups;
    migrated = true;
  }

  if (config.group_whitelist !== undefined) {
    config.groupPolicy = config.group_whitelist?.enabled !== false ? 'allowlist' : 'open';
    migrations.push(`Migrated group_whitelist.enabled=${config.group_whitelist?.enabled} → groupPolicy=${config.groupPolicy}`);
    config._legacy_group_whitelist = config.group_whitelist;
    delete config.group_whitelist;
    migrated = true;
  }

  if (!config.groupPolicy) {
    config.groupPolicy = 'allowlist';
    migrations.push('Set default groupPolicy=allowlist');
    migrated = true;
  }

  return { migrated, migrations };
}

// Export for use in post-upgrade hook
export { migrateGroupConfig };

// Main
const args = process.argv.slice(2);
const command = args[0] || 'help';

if (commands[command]) {
  commands[command](...args.slice(1));
} else {
  console.error(`Unknown command: ${command}`);
  commands.help();
  process.exit(1);
}
