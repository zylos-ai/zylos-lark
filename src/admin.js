#!/usr/bin/env node
/**
 * zylos-lark admin CLI
 * Manage lark bot configuration
 *
 * Usage: node admin.js <command> [args]
 */

import { loadConfig, saveConfig } from './lib/config.js';

// Global group policies (smart/mention are per-group modes, not global policies)
const VALID_GROUP_POLICIES = new Set(['disabled', 'allowlist', 'open']);

// ============================================================
// Helper: get the groups map (new format) or derive from legacy
// ============================================================
function getGroupsMap(config) {
  return config.groups || {};
}

function saveConfigOrExit(config) {
  if (saveConfig(config)) return true;
  console.error('Failed to save config');
  process.exit(1);
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
    saveConfigOrExit(config);
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

    saveConfigOrExit(config);
    console.log('Run: pm2 restart zylos-lark');
  },

  // Backward-compatible aliases
  'remove-allowed-group': (chatId) => commands['remove-group'](chatId),
  'remove-smart-group': (chatId) => commands['remove-group'](chatId),

  'set-group-policy': (policy) => {
    const normalizedPolicy = String(policy || '').trim().toLowerCase();
    if (!VALID_GROUP_POLICIES.has(normalizedPolicy)) {
      console.error(`Invalid policy "${policy || ''}". Valid values: disabled, allowlist, open.`);
      console.error('Usage: admin.js set-group-policy <disabled|allowlist|open>');
      process.exit(1);
    }
    const config = loadConfig();
    config.groupPolicy = normalizedPolicy;
    saveConfigOrExit(config);
    console.log(`Group policy set to: ${normalizedPolicy}`);
    console.log('Run: pm2 restart zylos-lark');
  },

  'set-group-allowfrom': (chatId, ...userIds) => {
    const normalizedChatId = String(chatId || '').trim();
    if (!normalizedChatId || userIds.length === 0) {
      console.error('Usage: admin.js set-group-allowfrom <chat_id> <user_id1> [user_id2] ...');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.groups?.[normalizedChatId]) {
      console.error(`Group ${normalizedChatId} not configured. Add it first with add-group.`);
      process.exit(1);
    }
    const normalizedUserIds = [...new Set(userIds.map(id => String(id).trim()).filter(Boolean))];
    if (normalizedUserIds.length === 0) {
      console.error('Invalid allowFrom value. Provide at least one non-empty user ID or "*".');
      process.exit(1);
    }
    const invalidIds = normalizedUserIds.filter(id => /\s/.test(id));
    if (invalidIds.length > 0) {
      console.error(`Invalid user IDs (no whitespace allowed): ${invalidIds.join(', ')}`);
      process.exit(1);
    }
    config.groups[normalizedChatId].allowFrom = normalizedUserIds;
    saveConfigOrExit(config);
    console.log(`Set allowFrom for ${normalizedChatId}: [${normalizedUserIds.join(', ')}]`);
    console.log('Run: pm2 restart zylos-lark');
  },

  'set-group-history-limit': (chatId, limit) => {
    const normalizedChatId = String(chatId || '').trim();
    if (!normalizedChatId || limit === undefined) {
      console.error('Usage: admin.js set-group-history-limit <chat_id> <limit>');
      process.exit(1);
    }
    const limitText = String(limit).trim();
    if (!/^\d+$/.test(limitText)) {
      console.error(`Invalid history limit "${limit}". Must be an integer between 1 and 200.`);
      process.exit(1);
    }
    const parsedLimit = parseInt(limitText, 10);
    if (Number.isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      console.error(`Invalid history limit "${limit}". Must be between 1 and 200.`);
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.groups?.[normalizedChatId]) {
      console.error(`Group ${normalizedChatId} not configured. Add it first with add-group.`);
      process.exit(1);
    }
    config.groups[normalizedChatId].historyLimit = parsedLimit;
    saveConfigOrExit(config);
    console.log(`Set historyLimit for ${normalizedChatId}: ${parsedLimit}`);
    console.log('Run: pm2 restart zylos-lark');
  },

  'set-dm-policy': (policy) => {
    const valid = ['open', 'allowlist', 'owner'];
    policy = String(policy || '').trim().toLowerCase();
    if (!valid.includes(policy)) {
      console.error(`Usage: admin.js set-dm-policy <${valid.join('|')}>`);
      process.exit(1);
    }
    const config = loadConfig();
    config.dmPolicy = policy;
    saveConfigOrExit(config);
    const desc = { open: 'Anyone can DM', allowlist: 'Only dmAllowFrom users can DM', owner: 'Only owner can DM' };
    console.log(`DM policy set to: ${policy} (${desc[policy]})`);
    console.log('Run: pm2 restart zylos-lark');
  },

  'list-dm-allow': () => {
    const config = loadConfig();
    console.log(`DM policy: ${config.dmPolicy || 'owner'}`);
    console.log(`Group policy: ${config.groupPolicy || 'allowlist'}`);
    const allowFrom = config.dmAllowFrom || [];
    console.log(`DM allowFrom (${allowFrom.length}):`, allowFrom.length ? allowFrom.join(', ') : 'none');
  },

  'add-dm-allow': (userId) => {
    if (!userId) {
      console.error('Usage: admin.js add-dm-allow <user_id_or_open_id>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) {
      config.dmAllowFrom = [];
    }
    if (!config.dmAllowFrom.includes(userId)) {
      config.dmAllowFrom.push(userId);
    }
    saveConfigOrExit(config);
    console.log(`Added ${userId} to dmAllowFrom`);
    if ((config.dmPolicy || 'owner') !== 'allowlist') {
      console.log(`Note: dmPolicy is "${config.dmPolicy || 'owner'}", set to "allowlist" for this to take effect.`);
    }
    console.log('Run: pm2 restart zylos-lark');
  },

  'remove-dm-allow': (userId) => {
    if (!userId) {
      console.error('Usage: admin.js remove-dm-allow <user_id_or_open_id>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) {
      console.log('No dmAllowFrom configured');
      return;
    }
    const idx = config.dmAllowFrom.indexOf(userId);
    if (idx !== -1) {
      config.dmAllowFrom.splice(idx, 1);
      saveConfigOrExit(config);
      console.log(`Removed ${userId} from dmAllowFrom`);
    } else {
      console.log(`${userId} not found in dmAllowFrom`);
    }
  },

  // Legacy whitelist commands → mapped to dmPolicy
  'list-whitelist': () => commands['list-dm-allow'](),
  'enable-whitelist': () => commands['set-dm-policy']('allowlist'),
  'disable-whitelist': () => commands['set-dm-policy']('open'),
  'add-whitelist': (userId) => commands['add-dm-allow'](userId),
  'remove-whitelist': (userId) => commands['remove-dm-allow'](userId),

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
      saveConfigOrExit(config);
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
  set-group-policy <policy>           Set group policy (disabled|allowlist|open)
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

  DM Access Control:
  set-dm-policy <open|allowlist|owner> Set DM policy
  list-dm-allow                       Show DM policy and allowFrom list
  add-dm-allow <user_id_or_open_id>   Add user to dmAllowFrom
  remove-dm-allow <id>                Remove user from dmAllowFrom

  Legacy (whitelist → dmPolicy aliases):
  list-whitelist                      → list-dm-allow
  add-whitelist <id>                  → add-dm-allow
  remove-whitelist <id>               → remove-dm-allow
  enable-whitelist                    → set-dm-policy allowlist
  disable-whitelist                   → set-dm-policy open

  show-owner                          Show current owner

Permission flow:
  Private DM:  dmPolicy (open|allowlist|owner) + dmAllowFrom
  Group chat:  groupPolicy → groups config → per-group allowFrom
  Owner always bypasses all checks.

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

  // Migrate legacy whitelist → cleanup and merge users into dmAllowFrom
  // Note: dmPolicy is already correctly set by loadConfig()'s runtime migration;
  // this migration only handles user data transfer and legacy field cleanup
  if (config.whitelist) {
    // Merge both private_users and group_users into dmAllowFrom
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
    migrations.push(`Migrated whitelist: ${(config.dmAllowFrom || []).length} users in dmAllowFrom, dmPolicy=${config.dmPolicy}`);
    delete config.whitelist;
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
