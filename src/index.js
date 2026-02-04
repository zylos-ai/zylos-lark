#!/usr/bin/env node
/**
 * zylos-lark - Lark/Feishu Bot Service
 *
 * Webhook server for receiving Lark messages and routing to Claude.
 */

import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getConfig, watchConfig, DATA_DIR, getCredentials } from './lib/config.js';
import { downloadImage, downloadFile } from './lib/message.js';
import { getUserInfo } from './lib/contact.js';

const __filename = fileURLToPath(import.meta.url);

// C4 receive interface path
const C4_RECEIVE = path.join(process.env.HOME, '.claude/skills/comm-bridge/c4-receive.js');
const __dirname = path.dirname(__filename);

// Initialize
console.log(`[lark] Starting...`);
console.log(`[lark] Data directory: ${DATA_DIR}`);

// Ensure directories exist
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const FILES_DIR = path.join(DATA_DIR, 'files');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
fs.mkdirSync(path.join(LOGS_DIR, 'private'), { recursive: true });
fs.mkdirSync(path.join(LOGS_DIR, 'group'), { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

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
    console.log(`[!] Failed to lookup user ${userId}: ${err.message}`);
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

// Log message
async function logMessage(chatType, chatId, userId, text, messageId, timestamp) {
  const userName = await resolveUserName(userId);
  const logEntry = {
    timestamp: timestamp || new Date().toISOString(),
    message_id: messageId,
    user_id: userId,
    user_name: userName,
    text: text
  };
  const logLine = JSON.stringify(logEntry) + '\n';

  if (chatType === 'p2p') {
    const logFile = path.join(LOGS_DIR, 'private', `${userId}.log`);
    fs.appendFileSync(logFile, logLine);
  } else {
    const logFile = path.join(LOGS_DIR, 'group', `${chatId}.log`);
    fs.appendFileSync(logFile, logLine);
  }
  console.log(`[*] Logged: [${userName}] ${text.substring(0, 30)}...`);
}

// Get group context messages
function getGroupContext(chatId, currentMessageId) {
  const logFile = path.join(LOGS_DIR, 'group', `${chatId}.log`);
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
 * Send message to Claude via C4
 */
function sendToC4(source, endpoint, content) {
  const safeContent = content.replace(/'/g, "'\\''");
  const cmd = `node "${C4_RECEIVE}" --source "${source}" --endpoint "${endpoint}" --content '${safeContent}'`;

  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      console.error(`[lark] C4 receive error: ${error.message}`);
    } else {
      console.log(`[lark] Sent to C4: ${content.substring(0, 50)}...`);
    }
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

// Check whitelist
function isWhitelisted(userId) {
  if (!config.whitelist?.enabled) return true;
  const allowedUsers = [...(config.whitelist.private_users || []), ...(config.whitelist.group_users || [])];
  return allowedUsers.includes(userId);
}

// Express app
const app = express();
app.use(express.json());

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  console.log('[*] Received webhook request');

  let event = req.body;

  // Handle encrypted events
  if (event.encrypt && config.bot?.encrypt_key) {
    try {
      event = decrypt(event.encrypt, config.bot.encrypt_key);
    } catch (err) {
      console.error('[!] Decryption failed:', err.message);
      return res.status(400).json({ error: 'Decryption failed' });
    }
  }

  // URL Verification Challenge
  if (event.type === 'url_verification') {
    console.log('[+] URL verification challenge received');
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
    console.log(`[*] ${chatType} message from ${senderUserId}: ${text.substring(0, 50) || '[media]'}...`);

    // Log message
    logMessage(chatType, chatId, senderUserId, text, messageId, event.header.create_time);

    // Private chat handling
    if (chatType === 'p2p') {
      if (!isWhitelisted(senderUserId)) {
        console.log(`[!] Private message from non-whitelisted user ${senderUserId}, ignoring`);
        return res.json({ code: 0 });
      }

      const senderName = await resolveUserName(senderUserId);

      if (imageKey) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const localPath = path.join(PHOTOS_DIR, `lark-${timestamp}.png`);
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
        const localPath = path.join(FILES_DIR, `lark-${timestamp}-${fileName}`);
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
      const creds = getCredentials();
      const mentioned = isBotMentioned(mentions, creds.app_id);

      if (!mentioned) {
        console.log(`[*] Group message without @mention, logged but not responding`);
        return res.json({ code: 0 });
      }

      if (!isWhitelisted(senderUserId)) {
        console.log(`[!] @mention from non-whitelisted user ${senderUserId} in group, ignoring`);
        return res.json({ code: 0 });
      }

      console.log(`[+] Bot @mentioned in group ${chatId}`);
      const contextMessages = getGroupContext(chatId, messageId);
      updateCursor(chatId, messageId);

      const senderName = await resolveUserName(senderUserId);
      const cleanText = text.replace(/@\w+\s*/gi, '').trim();

      if (imageKey) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const localPath = path.join(PHOTOS_DIR, `lark-group-${timestamp}.png`);
        const result = await downloadImage(messageId, imageKey, localPath);
        if (result.success) {
          const message = formatMessage('group', senderName, `[image]${cleanText ? ' ' + cleanText : ''}`, contextMessages, localPath);
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

// Start server
const PORT = config.webhook_port || 3457;
app.listen(PORT, () => {
  console.log(`[+] Lark Bot webhook server running on port ${PORT}`);
  console.log(`[*] Webhook URL: Configure in Lark app settings`);
});
