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
    verification_token: '',
    encrypt_key: ''
  },
  // Whitelist settings (disabled by default)
  whitelist: {
    enabled: false,
    private_users: [],
    group_users: []
  },
  // Proxy settings (optional)
  proxy: {
    enabled: false,
    host: '',
    port: 0
  },
  // Message settings
  message: {
    max_length: 2000,
    context_messages: 10
  }
};

let config = null;
let configWatcher = null;

/**
 * Load configuration from file
 */
export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf8');
      config = { ...DEFAULT_CONFIG, ...JSON.parse(content) };
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
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
    config = newConfig;
  } catch (err) {
    console.error(`[lark] Failed to save config: ${err.message}`);
    throw err;
  }
}

/**
 * Watch config file for changes
 */
export function watchConfig(onChange) {
  if (configWatcher) {
    configWatcher.close();
  }

  if (fs.existsSync(CONFIG_PATH)) {
    configWatcher = fs.watch(CONFIG_PATH, (eventType) => {
      if (eventType === 'change') {
        console.log('[lark] Config file changed, reloading...');
        loadConfig();
        if (onChange) {
          onChange(config);
        }
      }
    });
  }
}

/**
 * Stop watching config file
 */
export function stopWatching() {
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
