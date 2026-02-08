#!/usr/bin/env node
/**
 * zylos-lark - Lark/Feishu Bot Service
 *
 * Webhook server for receiving Lark messages and routing to Claude.
 */

import dotenv from 'dotenv';
import express from 'express';
import crypto from 'crypto';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

// Load .env from ~/zylos/.env (absolute path, not cwd-dependent)
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig, watchConfig, saveConfig, DATA_DIR, getCredentials } from './lib/config.js';
import { downloadImage, downloadFile } from './lib/message.js';
import { getUserInfo } from './lib/contact.js';
import { getBotInfo } from './lib/client.js';

// C4 receive interface path
const C4_RECEIVE = path.join(process.env.HOME, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');

// Bot identity (fetched at startup)
let botOpenId = '';

// Initialize
console.log(`[lark] Starting...`);
console.log(`[lark] Data directory: ${DATA_DIR}`);

// Ensure directories exist
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// State files
const CURSORS_PATH = path.join(DATA_DIR, 'group-cursors.json');
const USER_CACHE_PATH = path.join(DATA_DIR, 'user-cache.json');

// Load configuration
let config = getConfig();
console.log(`[lark] Config loaded, enabled: ${config.enabled}`);

if (!config.enabled) {
  console.log(`[lark] Component disabled in config, exiting.`);
  process.exit(0);
}

// Watch for config changes
watchConfig((newConfig) => {
  console.log(`[lark] Config reloaded`);
  config = newConfig;
  if (!newConfig.enabled) {
    console.log(`[lark] Component disabled, stopping...`);
    shutdown();
  }
});

// Load/save group cursors
function loadCursors() {
  try {
    if (fs.existsSync(CURSORS_PATH)) {
      return JSON.parse(fs.readFileSync(CURSORS_PATH, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveCursors(cursors) {
  fs.writeFileSync(CURSORS_PATH, JSON.stringify(cursors, null, 2));
}

// User name cache
function loadUserCache() {
  try {
    if (fs.existsSync(USER_CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(USER_CACHE_PATH, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveUserCache(cache) {
  fs.writeFileSync(USER_CACHE_PATH, JSON.stringify(cache, null, 2));
}

let userCache = loadUserCache();
let groupCursors = loadCursors();

// Resolve user_id to name
async function resolveUserName(userId) {
  if (!userId) return 'unknown';
  if (userCache[userId]) return userCache[userId];

  try {
    const result = await getUserInfo(userId);
    if (result.success && result.user?.name) {
      userCache[userId] = result.user.name;
      saveUserCache(userCache);
      return result.user.name;
    }
  } catch (err) {
    console.log(`[lark] Failed to lookup user ${userId}: ${err.message}`);
  }
  return userId;
}

// Decrypt message if encrypt_key is set
function decrypt(encrypt, encryptKey) {
  if (!encryptKey) return null;
  const encryptBuffer = Buffer.from(encrypt, 'base64');
  const key = crypto.createHash('sha256').update(encryptKey).digest();
  const iv = encryptBuffer.slice(0, 16);
  const encrypted = encryptBuffer.slice(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

// Log message (mentions resolved to real names for readable context)
async function logMessage(chatType, chatId, userId, openId, text, messageId, timestamp, mentions) {
  const userName = await resolveUserName(userId);
  const resolvedText = resolveMentions(text, mentions);
  const logEntry = {
    timestamp: timestamp || new Date().toISOString(),
    message_id: messageId,
    user_id: userId,
    open_id: openId,
    user_name: userName,
    text: resolvedText
  };
  const logLine = JSON.stringify(logEntry) + '\n';

  // Use chatId for groups (oc_xxx), userId for private chats
  const logId = chatType === 'p2p' ? userId : chatId;
  const logFile = path.join(LOGS_DIR, `${logId}.log`);
  fs.appendFileSync(logFile, logLine);
  console.log(`[lark] Logged: [${userName}] ${(resolvedText || '').substring(0, 30)}...`);
}

// Get group context messages
function getGroupContext(chatId, currentMessageId) {
  const logFile = path.join(LOGS_DIR, `${chatId}.log`);
  if (!fs.existsSync(logFile)) return [];

  const MIN_CONTEXT = 5;
  const MAX_CONTEXT = config.message?.context_messages || 10;
  const cursor = groupCursors[chatId] || null;
  const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(l => l);

  const messages = lines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(m => m);

  let cursorIndex = -1;
  let currentIndex = messages.length - 1;

  if (cursor) {
    cursorIndex = messages.findIndex(m => m.message_id === cursor);
  }

  let contextMessages = messages.slice(cursorIndex + 1, currentIndex);

  if (contextMessages.length < MIN_CONTEXT && currentIndex > 0) {
    const startIndex = Math.max(0, currentIndex - MIN_CONTEXT);
    contextMessages = messages.slice(startIndex, currentIndex);
  }

  return contextMessages.slice(-MAX_CONTEXT);
}

function updateCursor(chatId, messageId) {
  groupCursors[chatId] = messageId;
  saveCursors(groupCursors);
}

// Check if bot is mentioned
function isBotMentioned(mentions, botOpenId) {
  if (!mentions || !Array.isArray(mentions)) return false;
  return mentions.some(m => {
    const mentionId = m.id?.open_id || m.id?.user_id || m.id?.app_id || '';
    return mentionId === botOpenId || m.key === '@_all';
  });
}

/**
 * Resolve @_user_N placeholders in message text to real names.
 * Lark replaces @mentions with @_user_1, @_user_2, etc. in the raw text.
 * The mentions array contains the mapping: { key: "@_user_1", name: "Hongyun", id: { ... } }
 *
 * @param {string} text - Raw message text with @_user_N placeholders
 * @param {Array} mentions - Lark mentions array from webhook event
 * @param {object} options
 * @param {boolean} options.stripBot - If true, remove the bot's @mention entirely
 * @param {string} options.botOpenId - Bot's open_id for identifying bot mention
 * @returns {string} Text with @_user_N replaced by @RealName (bot mention optionally stripped)
 */
function resolveMentions(text, mentions, { stripBot = false, botOpenId: botId } = {}) {
  if (!text || !mentions || !Array.isArray(mentions) || mentions.length === 0) return text;

  let resolved = text;
  for (const m of mentions) {
    if (!m.key) continue;
    const isBotMention = botId && (m.id?.open_id === botId || m.id?.app_id === botId);
    if (stripBot && isBotMention) {
      // Remove bot @mention entirely (including trailing space)
      resolved = resolved.replace(new RegExp(m.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'g'), '');
    } else if (m.name) {
      // Replace placeholder with real name
      resolved = resolved.replace(m.key, `@${m.name}`);
    }
  }
  return resolved.trim();
}

/**
 * Send message to Claude via C4 (with 1 retry on failure)
 */
function sendToC4(source, endpoint, content) {
  if (!content) {
    console.error('[lark] sendToC4 called with empty content');
    return;
  }
  const safeContent = content.replace(/'/g, "'\\''");
  const cmd = `node "${C4_RECEIVE}" --channel "${source}" --endpoint "${endpoint}" --content '${safeContent}'`;

  exec(cmd, (error) => {
    if (!error) {
      console.log(`[lark] Sent to C4: ${content.substring(0, 50)}...`);
      return;
    }
    console.warn(`[lark] C4 send failed, retrying in 2s: ${error.message}`);
    setTimeout(() => {
      exec(cmd, (retryError) => {
        if (retryError) {
          console.error(`[lark] C4 send failed after retry: ${retryError.message}`);
        } else {
          console.log(`[lark] Sent to C4 (retry): ${content.substring(0, 50)}...`);
        }
      });
    }, 2000);
  });
}

/**
 * Format message for C4
 */
function formatMessage(chatType, userName, text, contextMessages = [], mediaPath = null) {
  let prefix = chatType === 'p2p' ? '[Lark DM]' : '[Lark GROUP]';

  let contextPrefix = '';
  if (contextMessages.length > 0) {
    const contextLines = contextMessages.map(m => `[${m.user_name || m.user_id}]: ${m.text}`).join('\n');
    contextPrefix = `[Group context - recent messages before this @mention:]\n${contextLines}\n\n[Current message:] `;
  }

  let message = `${prefix} ${userName} said: ${contextPrefix}${text}`;

  if (mediaPath) {
    message += ` ---- file: ${mediaPath}`;
  }

  return message;
}

// Extract content from Lark message
function extractMessageContent(message) {
  const msgType = message.message_type;
  const content = JSON.parse(message.content || '{}');

  switch (msgType) {
    case 'text':
      return { text: content.text || '', imageKey: null, fileKey: null, fileName: null };
    case 'post':
      if (content.content) {
        const items = content.content.flat();
        const text = items.filter(item => item.tag === 'text').map(item => item.text || '').join('');
        const imgItem = items.find(item => item.tag === 'img');
        return { text, imageKey: imgItem?.image_key || null, fileKey: null, fileName: null };
      }
      return { text: '', imageKey: null, fileKey: null, fileName: null };
    case 'image':
      return { text: '', imageKey: content.image_key, fileKey: null, fileName: null };
    case 'file':
      return { text: '', imageKey: null, fileKey: content.file_key, fileName: content.file_name || 'unknown' };
    default:
      return { text: `[${msgType} message]`, imageKey: null, fileKey: null, fileName: null };
  }
}

// Bind owner (first private chat user)
async function bindOwner(userId, openId) {
  const userName = await resolveUserName(userId);
  config.owner = {
    bound: true,
    user_id: userId,
    open_id: openId,
    name: userName
  };
  saveConfig(config);
  console.log(`[lark] Owner bound: ${userName} (${userId})`);
  return userName;
}

// Check if user is owner
function isOwner(userId, openId) {
  if (!config.owner?.bound) return false;
  return config.owner.user_id === userId || config.owner.open_id === openId;
}

// Check whitelist (supports both user_id and open_id)
// Owner is always allowed
function isWhitelisted(userId, openId) {
  // Owner is always whitelisted
  if (isOwner(userId, openId)) return true;
  // If whitelist disabled, allow all
  if (!config.whitelist?.enabled) return true;
  const allowedUsers = [...(config.whitelist.private_users || []), ...(config.whitelist.group_users || [])];
  return allowedUsers.includes(userId) || (openId && allowedUsers.includes(openId));
}

// Express app
const app = express();
app.use(express.json());

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  console.log('[lark] Received webhook request');

  let event = req.body;

  // Handle encrypted events
  if (event.encrypt && config.bot?.encrypt_key) {
    try {
      event = decrypt(event.encrypt, config.bot.encrypt_key);
    } catch (err) {
      console.error('[lark] Decryption failed:', err.message);
      return res.status(400).json({ error: 'Decryption failed' });
    }
  }

  // URL Verification Challenge
  if (event.type === 'url_verification') {
    console.log('[lark] URL verification challenge received');
    return res.json({ challenge: event.challenge });
  }

  // Handle message event
  if (event.header?.event_type === 'im.message.receive_v1') {
    const message = event.event.message;
    const sender = event.event.sender;
    const mentions = message.mentions;

    const senderUserId = sender.sender_id?.user_id;
    const senderOpenId = sender.sender_id?.open_id;
    const chatId = message.chat_id;
    const messageId = message.message_id;
    const chatType = message.chat_type;

    const { text, imageKey, fileKey, fileName } = extractMessageContent(message);
    console.log(`[lark] ${chatType} message from ${senderUserId}: ${(text || '').substring(0, 50) || '[media]'}...`);

    // Build log text with file/image metadata for lazy download context
    let logText = text;
    if (imageKey) {
      const imageInfo = `[image, image_key: ${imageKey}, msg_id: ${messageId}]`;
      logText = logText ? `${logText}\n${imageInfo}` : imageInfo;
    }
    if (fileKey) {
      const fileInfo = `[file: ${fileName}, file_key: ${fileKey}, msg_id: ${messageId}]`;
      logText = logText ? `${logText}\n${fileInfo}` : fileInfo;
    }

    // Log message (file metadata + mentions for name resolution in context)
    logMessage(chatType, chatId, senderUserId, senderOpenId, logText, messageId, event.header.create_time, mentions);

    // Private chat handling
    if (chatType === 'p2p') {
      // Auto-bind first private chat user as owner
      if (!config.owner?.bound) {
        await bindOwner(senderUserId, senderOpenId);
      }

      if (!isWhitelisted(senderUserId, senderOpenId)) {
        console.log(`[lark] Private message from non-whitelisted user ${senderUserId}, ignoring`);
        return res.json({ code: 0 });
      }

      const senderName = await resolveUserName(senderUserId);

      if (imageKey) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const localPath = path.join(MEDIA_DIR, `lark-${timestamp}.png`);
        const result = await downloadImage(messageId, imageKey, localPath);
        if (result.success) {
          const message = formatMessage('p2p', senderName, `[image]${text ? ' ' + text : ''}`, [], localPath);
          sendToC4('lark', chatId, message);
        } else {
          const message = formatMessage('p2p', senderName, '[image download failed]');
          sendToC4('lark', chatId, message);
        }
        return res.json({ code: 0 });
      }

      if (fileKey) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const localPath = path.join(MEDIA_DIR, `lark-${timestamp}-${fileName}`);
        const result = await downloadFile(messageId, fileKey, localPath);
        if (result.success) {
          const message = formatMessage('p2p', senderName, `[file: ${fileName}]`, [], localPath);
          sendToC4('lark', chatId, message);
        } else {
          const message = formatMessage('p2p', senderName, `[file download failed: ${fileName}]`);
          sendToC4('lark', chatId, message);
        }
        return res.json({ code: 0 });
      }

      const message = formatMessage('p2p', senderName, text);
      sendToC4('lark', chatId, message);
      return res.json({ code: 0 });
    }

    // Group chat handling
    if (chatType === 'group') {
      const mentioned = isBotMentioned(mentions, botOpenId);
      const isSmartGroup = (config.smart_groups || []).some(g => g.chat_id === chatId);
      const allowedGroups = config.allowed_groups || [];
      // If allowed_groups is empty, all groups are allowed (open mode)
      // If allowed_groups has entries, only listed groups are allowed (restricted mode)
      const isAllowedGroup = allowedGroups.length === 0 || allowedGroups.some(g => g.chat_id === chatId);

      // Smart groups: receive all messages
      // Allowed groups (or open mode): respond to @mentions
      // Non-allowed groups: log only
      if (!isSmartGroup && !mentioned) {
        console.log(`[lark] Group message without @mention, logged only`);
        return res.json({ code: 0 });
      }

      // For non-smart groups, need @mention and permission check
      if (!isSmartGroup) {
        const senderIsOwner = isOwner(senderUserId, senderOpenId);

        // Owner can @mention bot in any group
        if (!isAllowedGroup && !senderIsOwner) {
          console.log(`[lark] @mention in non-allowed group ${chatId}, ignoring`);
          return res.json({ code: 0 });
        }
        if (!senderIsOwner && !isWhitelisted(senderUserId, senderOpenId)) {
          console.log(`[lark] @mention from non-whitelisted user ${senderUserId} in group, ignoring`);
          return res.json({ code: 0 });
        }
      }

      console.log(`[lark] ${isSmartGroup ? 'Smart group' : 'Bot @mentioned in'} group ${chatId}`);
      const contextMessages = getGroupContext(chatId, messageId);
      updateCursor(chatId, messageId);

      const senderName = await resolveUserName(senderUserId);
      // Resolve mentions: replace @_user_N with real names, strip bot's @mention only
      const cleanText = resolveMentions(text, mentions, { stripBot: true, botOpenId });

      if (imageKey) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const localPath = path.join(MEDIA_DIR, `lark-group-${timestamp}.png`);
        const result = await downloadImage(messageId, imageKey, localPath);
        if (result.success) {
          const message = formatMessage('group', senderName, `[image]${cleanText ? ' ' + cleanText : ''}`, contextMessages, localPath);
          sendToC4('lark', chatId, message);
        }
        return res.json({ code: 0 });
      }

      if (fileKey) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const localPath = path.join(MEDIA_DIR, `lark-group-${timestamp}-${fileName}`);
        const result = await downloadFile(messageId, fileKey, localPath);
        if (result.success) {
          const message = formatMessage('group', senderName, `[file: ${fileName}]${cleanText ? ' ' + cleanText : ''}`, contextMessages, localPath);
          sendToC4('lark', chatId, message);
        }
        return res.json({ code: 0 });
      }

      const message = formatMessage('group', senderName, cleanText || text, contextMessages);
      sendToC4('lark', chatId, message);
      return res.json({ code: 0 });
    }
  }

  res.json({ code: 0 });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'zylos-lark',
    cursors: Object.keys(groupCursors).length
  });
});

// Graceful shutdown
function shutdown() {
  console.log(`[lark] Shutting down...`);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Fetch bot identity then start server
const PORT = config.webhook_port || 3457;

(async () => {
  try {
    const botInfo = await getBotInfo();
    if (botInfo.success) {
      botOpenId = botInfo.open_id;
      console.log(`[lark] Bot identity: ${botInfo.app_name} (${botOpenId})`);
    } else {
      console.error(`[lark] Warning: Could not fetch bot info: ${botInfo.message}`);
      console.error('[lark] @mention detection in groups will not work');
    }
  } catch (err) {
    console.error(`[lark] Warning: getBotInfo failed: ${err.message}`);
  }

  app.listen(PORT, () => {
    console.log(`[lark] Webhook server running on port ${PORT}`);
  });
})();
