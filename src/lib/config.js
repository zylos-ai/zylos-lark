/**
 * Configuration loader for zylos-lark
 *
 * Loads config from ~/zylos/components/lark/config.json
 * Secrets from ~/zylos/.env (LARK_APP_ID, LARK_APP_SECRET)
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
export const DATA_DIR = path.join(HOME, 'zylos/components/lark');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Default configuration
export const DEFAULT_CONFIG = {
  enabled: true,
  webhook_port: 3457,
  // Bot settings
  bot: {
    encrypt_key: '',
    verification_token: ''
  },
  // Owner (primary partner) - auto-bound on first private chat
  owner: {
    bound: false,
    user_id: '',
    open_id: '',
    name: ''
  },
  // DM policy: 'open' (anyone can DM), 'allowlist' (only dmAllowFrom), 'owner' (owner only)
  dmPolicy: 'owner',
  // DM allowlist — user_id or open_id values (used when dmPolicy = 'allowlist')
  dmAllowFrom: [],
  // Group policy: 'open' (all groups), 'allowlist' (only configured groups), 'disabled' (no groups)
  groupPolicy: 'allowlist',
  // Per-group configuration map
  // Format: { "oc_xxx": { name, mode, requireMention, allowFrom, historyLimit } }
  // mode: "mention" (respond to @mentions) or "smart" (receive all messages)
  groups: {},
  // Legacy fields (kept for backward compatibility, migrated to groups on upgrade)
  // group_whitelist: { enabled: true },
  // allowed_groups: [],
  // smart_groups: [],
  // Proxy settings (optional)
  proxy: {
    enabled: false,
    host: '',
    port: 0
  },
  // Message settings
  message: {
    context_messages: 10,
    // Send messages as interactive cards with markdown rendering (default: off)
    useMarkdownCard: false
  }
};

let config = null;
let configWatcher = null;
let configReloadTimer = null;

/**
 * Load configuration from file
 */
export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(content);
      config = { ...DEFAULT_CONFIG, ...parsed };
      // Runtime backward-compat: derive groupPolicy from legacy group_whitelist
      if (config.group_whitelist !== undefined && !('groupPolicy' in parsed)) {
        config.groupPolicy = config.group_whitelist?.enabled !== false ? 'allowlist' : 'open';
      }
      // Runtime backward-compat: migrate legacy whitelist to dmPolicy/dmAllowFrom
      if (config.whitelist && !('dmPolicy' in parsed)) {
        const wlEnabled = config.whitelist.private_enabled ?? config.whitelist.enabled ?? false;
        config.dmPolicy = wlEnabled ? 'allowlist' : 'open';
        if (!('dmAllowFrom' in parsed)) {
          const legacyUsers = [
            ...(config.whitelist.private_users || []),
            ...(config.whitelist.group_users || [])
          ];
          if (legacyUsers.length) {
            config.dmAllowFrom = legacyUsers;
          }
        }
      }
    } else {
      console.warn(`[lark] Config file not found: ${CONFIG_PATH}`);
      config = { ...DEFAULT_CONFIG };
    }
  } catch (err) {
    console.error(`[lark] Failed to load config: ${err.message}`);
    config = { ...DEFAULT_CONFIG };
  }
  return config;
}

/**
 * Get current configuration
 */
export function getConfig() {
  if (!config) {
    loadConfig();
  }
  return config;
}

/**
 * Save configuration to file
 */
export function saveConfig(newConfig) {
  const tmpPath = CONFIG_PATH + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(newConfig, null, 2));
    fs.renameSync(tmpPath, CONFIG_PATH);
    config = newConfig;
    return true;
  } catch (err) {
    console.error(`[lark] Failed to save config: ${err.message}`);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    return false;
  }
}

/**
 * Watch config file for changes
 */
export function watchConfig(onChange) {
  if (configWatcher) {
    configWatcher.close();
  }
  if (configReloadTimer) {
    clearTimeout(configReloadTimer);
    configReloadTimer = null;
  }

  const configDir = path.dirname(CONFIG_PATH);
  const configBase = path.basename(CONFIG_PATH);

  const scheduleReload = () => {
    if (configReloadTimer) clearTimeout(configReloadTimer);
    configReloadTimer = setTimeout(() => {
      configReloadTimer = null;
      if (!fs.existsSync(CONFIG_PATH)) {
        return;
      }
      console.log('[lark] Config file changed, reloading...');
      loadConfig();
      if (onChange) {
        onChange(config);
      }
    }, 100);
  };

  if (fs.existsSync(configDir)) {
    configWatcher = fs.watch(configDir, (eventType, filename) => {
      if (filename && String(filename) === configBase) {
        scheduleReload();
      }
    });
    configWatcher.on('error', (err) => {
      console.warn(`[lark] Config watcher error: ${err.message}`);
      if (configReloadTimer) {
        clearTimeout(configReloadTimer);
        configReloadTimer = null;
      }
      try {
        configWatcher.close();
      } catch {}
      configWatcher = null;
    });
  }
}

/**
 * Stop watching config file
 */
export function stopWatching() {
  if (configReloadTimer) {
    clearTimeout(configReloadTimer);
    configReloadTimer = null;
  }
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
}

/**
 * Get credentials from environment
 */
export function getCredentials() {
  return {
    app_id: process.env.LARK_APP_ID || '',
    app_secret: process.env.LARK_APP_SECRET || ''
  };
}

/**
 * Get proxy config for axios
 */
export function getProxyConfig() {
  const cfg = getConfig();
  if (cfg.proxy?.enabled && cfg.proxy?.host && cfg.proxy?.port) {
    return {
      host: cfg.proxy.host,
      port: cfg.proxy.port
    };
  }
  return false;
}
