#!/usr/bin/env node
/**
 * zylos-lark admin CLI
 * Manage lark bot configuration
 *
 * Usage: node admin.js <command> [args]
 */

import { loadConfig, saveConfig } from './lib/config.js';

// Commands
const commands = {
  'show': () => {
    const config = loadConfig();
    console.log(JSON.stringify(config, null, 2));
  },

  'list-allowed-groups': () => {
    const config = loadConfig();
    const groups = config.allowed_groups || [];
    if (groups.length === 0) {
      console.log('No allowed groups configured');
    } else {
      console.log('Allowed Groups (can @mention bot):');
      groups.forEach(g => {
        console.log(`  ${g.chat_id} - ${g.name} (added: ${g.added_at || 'unknown'})`);
      });
    }
  },

  'add-allowed-group': (chatId, name) => {
    if (!chatId || !name) {
      console.error('Usage: admin.js add-allowed-group <chat_id> <name>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.allowed_groups) {
      config.allowed_groups = [];
    }

    const exists = config.allowed_groups.find(g => String(g.chat_id) === String(chatId));
    if (exists) {
      console.log(`Group ${chatId} already in allowed_groups`);
      return;
    }

    config.allowed_groups.push({
      chat_id: chatId,
      name: name,
      added_at: new Date().toISOString()
    });
    saveConfig(config);
    console.log(`Added allowed group: ${chatId} (${name})`);
    console.log('Run: pm2 restart zylos-lark');
  },

  'remove-allowed-group': (chatId) => {
    if (!chatId) {
      console.error('Usage: admin.js remove-allowed-group <chat_id>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.allowed_groups) {
      console.log('No allowed groups configured');
      return;
    }

    const index = config.allowed_groups.findIndex(g => String(g.chat_id) === String(chatId));
    if (index === -1) {
      console.log(`Group ${chatId} not found in allowed_groups`);
      return;
    }

    const removed = config.allowed_groups.splice(index, 1)[0];
    saveConfig(config);
    console.log(`Removed allowed group: ${chatId} (${removed.name})`);
    console.log('Run: pm2 restart zylos-lark');
  },

  'list-smart-groups': () => {
    const config = loadConfig();
    const groups = config.smart_groups || [];
    if (groups.length === 0) {
      console.log('No smart groups configured');
    } else {
      console.log('Smart Groups (receive all messages):');
      groups.forEach(g => {
        console.log(`  ${g.chat_id} - ${g.name} (added: ${g.added_at || 'unknown'})`);
      });
    }
  },

  'add-smart-group': (chatId, name) => {
    if (!chatId || !name) {
      console.error('Usage: admin.js add-smart-group <chat_id> <name>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.smart_groups) {
      config.smart_groups = [];
    }

    const exists = config.smart_groups.find(g => String(g.chat_id) === String(chatId));
    if (exists) {
      console.log(`Group ${chatId} already in smart_groups`);
      return;
    }

    config.smart_groups.push({
      chat_id: chatId,
      name: name,
      added_at: new Date().toISOString()
    });
    saveConfig(config);
    console.log(`Added smart group: ${chatId} (${name})`);
    console.log('Run: pm2 restart zylos-lark');
  },

  'remove-smart-group': (chatId) => {
    if (!chatId) {
      console.error('Usage: admin.js remove-smart-group <chat_id>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.smart_groups) {
      console.log('No smart groups configured');
      return;
    }

    const index = config.smart_groups.findIndex(g => String(g.chat_id) === String(chatId));
    if (index === -1) {
      console.log(`Group ${chatId} not found in smart_groups`);
      return;
    }

    const removed = config.smart_groups.splice(index, 1)[0];
    saveConfig(config);
    console.log(`Removed smart group: ${chatId} (${removed.name})`);
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
      config.whitelist = { enabled: true, private_users: [], group_users: [] };
    }
    if (!config.whitelist.enabled) {
      config.whitelist.enabled = true;
    }

    // Add to both lists (user_id for private, open_id for groups)
    if (!config.whitelist.private_users.includes(userId)) {
      config.whitelist.private_users.push(userId);
    }
    if (!config.whitelist.group_users.includes(userId)) {
      config.whitelist.group_users.push(userId);
    }
    saveConfig(config);
    console.log(`Added ${userId} to whitelist (private + group)`);
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

  'help': () => {
    console.log(`
zylos-lark admin CLI

Commands:
  show                                Show full config

  Allowed Groups (respond to @mentions):
  list-allowed-groups                 List allowed groups
  add-allowed-group <chat_id> <name>  Add an allowed group
  remove-allowed-group <chat_id>      Remove an allowed group

  Smart Groups (receive all messages):
  list-smart-groups                   List smart groups
  add-smart-group <chat_id> <name>    Add a smart group
  remove-smart-group <chat_id>        Remove a smart group

  Whitelist (access control):
  list-whitelist                      List whitelist entries
  add-whitelist <user_id_or_open_id>  Add to whitelist
  remove-whitelist <user_id_or_open_id>  Remove from whitelist

  show-owner                          Show current owner

After changes, restart bot: pm2 restart zylos-lark
`);
  }
};

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
