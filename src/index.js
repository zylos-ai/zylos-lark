#!/usr/bin/env node
/**
 * zylos-lark - Lark Bot Service
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
import { downloadImage, downloadFile, sendMessage, extractPermissionError, addReaction, removeReaction, listMessages } from './lib/message.js';
import { getUserInfo } from './lib/contact.js';
import { getBotInfo } from './lib/client.js';

// C4 receive interface path
const C4_RECEIVE = path.join(process.env.HOME, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');

// Bot identity (fetched at startup)
let botOpenId = '';
let botAppName = '';

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

// ============================================================
// Message deduplication
// ============================================================
const DEDUP_TTL = 5 * 60 * 1000; // 5 minutes
const processedMessages = new Map();

function isDuplicate(messageId) {
  if (!messageId) return false;
  if (processedMessages.has(messageId)) {
    console.log(`[lark] Duplicate message_id ${messageId}, skipping`);
    return true;
  }
  processedMessages.set(messageId, Date.now());
  // Cleanup old entries
  if (processedMessages.size > 200) {
    const now = Date.now();
    for (const [id, ts] of processedMessages) {
      if (now - ts > DEDUP_TTL) processedMessages.delete(id);
    }
  }
  return false;
}

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

// ============================================================
// Typing indicator (emoji reaction on message while processing)
// ============================================================
const TYPING_EMOJI = 'Typing';  // ⌨️ keyboard typing indicator
const TYPING_TIMEOUT = 120 * 1000; // 120 seconds max

// Track active typing indicators: Map<messageId, { reactionId, timer }>
const activeTypingIndicators = new Map();

/**
 * Add a typing indicator (emoji reaction) to a message.
 */
async function addTypingIndicator(messageId) {
  try {
    const result = await addReaction(messageId, TYPING_EMOJI);
    if (result.success && result.reactionId) {
      const timer = setTimeout(() => {
        removeTypingIndicator(messageId);
      }, TYPING_TIMEOUT);

      activeTypingIndicators.set(messageId, {
        reactionId: result.reactionId,
        timer,
      });

      return true;
    }
  } catch (err) {
    console.log(`[lark] Failed to add typing indicator: ${err.message}`);
  }
  return false;
}

/**
 * Remove a typing indicator from a message.
 */
async function removeTypingIndicator(messageId) {
  const state = activeTypingIndicators.get(messageId);
  if (!state) return;

  clearTimeout(state.timer);

  try {
    const result = await removeReaction(messageId, state.reactionId);
    if (!result.success) {
      await new Promise(r => setTimeout(r, 1000));
      await removeReaction(messageId, state.reactionId);
    }
  } catch (err) {
    console.log(`[lark] Failed to remove typing indicator: ${err.message}`);
  }

  activeTypingIndicators.delete(messageId);
}

/**
 * Check for typing-done marker files written by send.js.
 */
const TYPING_DIR = path.join(DATA_DIR, 'typing');
fs.mkdirSync(TYPING_DIR, { recursive: true });

// Clean up stale typing markers from previous run
try {
  const staleFiles = fs.readdirSync(TYPING_DIR);
  for (const f of staleFiles) {
    try { fs.unlinkSync(path.join(TYPING_DIR, f)); } catch {}
  }
  if (staleFiles.length > 0) console.log(`[lark] Cleaned ${staleFiles.length} stale typing markers`);
} catch {}

function checkTypingDoneMarkers() {
  try {
    const files = fs.readdirSync(TYPING_DIR);
    const now = Date.now();
    for (const file of files) {
      if (!file.endsWith('.done')) continue;
      const messageId = file.replace('.done', '');
      const filePath = path.join(TYPING_DIR, file);

      if (activeTypingIndicators.has(messageId)) {
        removeTypingIndicator(messageId);
        console.log(`[lark] Typing indicator removed for ${messageId} (reply sent)`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      } else {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const markerTime = parseInt(content, 10);
          if (now - markerTime > 60000) {
            fs.unlinkSync(filePath);
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

// Poll for typing-done markers every 2 seconds
setInterval(checkTypingDoneMarkers, 2000);

// ============================================================
// Permission error tracking (cooldown to avoid spam)
// ============================================================
const PERMISSION_ERROR_COOLDOWN = 5 * 60 * 1000; // 5 minutes
let lastPermissionErrorNotified = 0;

function handlePermissionError(permErr) {
  const now = Date.now();
  if (now - lastPermissionErrorNotified < PERMISSION_ERROR_COOLDOWN) return;
  lastPermissionErrorNotified = now;

  const grantUrl = permErr.grantUrl || '';
  const msg = `[System] Lark API permission error (code ${permErr.code}): ${permErr.message}`;
  const detail = grantUrl
    ? `${msg}\nGrant permissions at: ${grantUrl}`
    : msg;

  console.error(`[lark] ${detail}`);

  if (config.owner?.bound && config.owner?.open_id) {
    const alertText = `[Lark SYSTEM] Permission error detected: ${permErr.message}${grantUrl ? '\nAdmin grant URL: ' + grantUrl : ''}`;
    sendMessage(config.owner.open_id, alertText, 'open_id', 'text')
      .catch(e => console.error('[lark] Failed to send permission alert to owner:', e.message));
  }
}

// ============================================================
// User name cache with TTL (in-memory primary, file for cold start)
// ============================================================
const SENDER_NAME_TTL = 10 * 60 * 1000; // 10 minutes

const userCacheMemory = new Map();

function loadUserCacheFromFile() {
  try {
    if (fs.existsSync(USER_CACHE_PATH)) {
      const data = JSON.parse(fs.readFileSync(USER_CACHE_PATH, 'utf-8'));
      const now = Date.now();
      for (const [userId, name] of Object.entries(data)) {
        if (typeof name === 'string') {
          userCacheMemory.set(userId, { name, expireAt: now + SENDER_NAME_TTL });
        }
      }
      console.log(`[lark] Loaded ${userCacheMemory.size} names from file cache`);
    }
  } catch (err) {
    console.log(`[lark] Failed to load user cache file: ${err.message}`);
  }
}

let _userCacheDirty = false;
function persistUserCache() {
  if (!_userCacheDirty) return;
  _userCacheDirty = false;
  const obj = {};
  for (const [userId, entry] of userCacheMemory) {
    obj[userId] = entry.name;
  }
  try {
    fs.writeFileSync(USER_CACHE_PATH, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.log(`[lark] Failed to persist user cache: ${err.message}`);
  }
}

// Persist cache every 5 minutes
setInterval(persistUserCache, 5 * 60 * 1000);

// Load file cache on startup
loadUserCacheFromFile();

let groupCursors = loadCursors();

// ============================================================
// In-memory chat history (replaces file-based context building)
// File logs are kept for audit; this Map is used for fast context.
// ============================================================
const DEFAULT_HISTORY_LIMIT = 5;
const chatHistories = new Map();

function recordHistoryEntry(chatId, entry) {
  if (!chatHistories.has(chatId)) {
    chatHistories.set(chatId, []);
  }
  const history = chatHistories.get(chatId);
  // Deduplicate by message_id (lazy load + real-time can overlap)
  if (entry.message_id && history.some(m => m.message_id === entry.message_id)) {
    return;
  }
  history.push(entry);
  const limit = getGroupHistoryLimit(chatId);
  if (history.length > limit * 2) {
    chatHistories.set(chatId, history.slice(-limit));
  }
}

function getInMemoryContext(chatId, currentMessageId) {
  const history = chatHistories.get(chatId);
  if (!history || history.length === 0) return [];

  const limit = getGroupHistoryLimit(chatId);
  const filtered = history.filter(m => m.message_id !== currentMessageId);
  const count = Math.min(limit, filtered.length);
  return filtered.slice(-count);
}

/**
 * Get context with lazy load fallback.
 * If in-memory history is empty (e.g. after restart), fetch from API once.
 */
const _lazyLoadedContainers = new Set();

async function getContextWithFallback(containerId, currentMessageId, containerType = 'chat') {
  const context = getInMemoryContext(containerId, currentMessageId);
  if (context.length > 0 || _lazyLoadedContainers.has(containerId)) {
    return context;
  }

  _lazyLoadedContainers.add(containerId);
  try {
    const limit = containerType === 'thread'
      ? (config.message?.context_messages || DEFAULT_HISTORY_LIMIT)
      : getGroupHistoryLimit(containerId);
    const result = await listMessages(containerId, limit, 'desc', null, null, containerType);
    if (result.success && result.messages.length > 0) {
      const msgs = result.messages.reverse();
      for (const msg of msgs) {
        const userName = await resolveUserName(msg.sender);
        let text = msg.content;
        if (msg.type === 'post' && typeof text === 'string') {
          try {
            const parsed = JSON.parse(text);
            const content = parsed.content || [];
            ({ text } = extractPostText(content, msg.id));
          } catch { /* use raw content */ }
        }
        if (msg.mentions && msg.mentions.length > 0) {
          text = resolveMentions(text, msg.mentions);
        }
        recordHistoryEntry(containerId, {
          timestamp: msg.createTime,
          message_id: msg.id,
          user_id: msg.sender,
          user_name: userName,
          text
        });
      }
      console.log(`[lark] Lazy-loaded ${msgs.length} messages for ${containerType} ${containerId}`);
      return getInMemoryContext(containerId, currentMessageId);
    }
  } catch (err) {
    console.log(`[lark] Lazy-load failed for ${containerType} ${containerId}: ${err.message}`);
  }
  return context;
}

// Resolve user_id to name (with TTL-based in-memory cache)
async function resolveUserName(userId) {
  if (!userId) return 'unknown';

  // Recognize bot's own messages (open_id or app_id prefix)
  if (botOpenId && userId === botOpenId) return botAppName || 'bot';
  if (userId.startsWith('cli_')) return botAppName || 'bot';

  const now = Date.now();
  const cached = userCacheMemory.get(userId);
  if (cached && cached.expireAt > now) {
    return cached.name;
  }

  try {
    const result = await getUserInfo(userId);
    if (result.success && result.user?.name) {
      userCacheMemory.set(userId, { name: result.user.name, expireAt: now + SENDER_NAME_TTL });
      _userCacheDirty = true;
      return result.user.name;
    }
    if (!result.success && result.code === 99991672) {
      handlePermissionError({ code: result.code, message: result.message || '' });
    }
  } catch (err) {
    const permErr = extractPermissionError(err);
    if (permErr) {
      handlePermissionError(permErr);
    } else {
      console.log(`[lark] Failed to lookup user ${userId}: ${err.message}`);
    }
    if (cached) return cached.name;
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

// Log message — also records to in-memory chat history for fast context building.
async function logMessage(chatType, chatId, userId, openId, text, messageId, timestamp, mentions, threadId = null) {
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

  // File log for audit
  const logId = chatType === 'p2p' ? userId : chatId;
  const logFile = path.join(LOGS_DIR, `${logId}.log`);
  fs.appendFileSync(logFile, logLine);

  // In-memory history for context (group chats and threads)
  // Thread messages go to thread history only (context isolation)
  if (threadId) {
    recordHistoryEntry(threadId, logEntry);
  } else if (chatType === 'group') {
    recordHistoryEntry(chatId, logEntry);
  }

  console.log(`[lark] Logged: [${userName}] ${(resolvedText || '').substring(0, 30)}...`);
}

// Get group context messages (with API fallback after restart)
async function getGroupContext(chatId, currentMessageId) {
  return getContextWithFallback(chatId, currentMessageId, 'chat');
}

function updateCursor(chatId, messageId) {
  groupCursors[chatId] = messageId;
  saveCursors(groupCursors);
}

// ============================================================
// Group policy helpers
// ============================================================

function resolveGroupConfig(chatId) {
  const groups = config.groups || {};
  return groups[chatId];
}

function isGroupAllowed(chatId) {
  const groupPolicy = config.groupPolicy || 'allowlist';

  if (groupPolicy === 'disabled') return false;
  if (groupPolicy === 'open') return true;

  const groupConfig = resolveGroupConfig(chatId);
  if (groupConfig) return true;

  // Backward compat: check legacy arrays
  const legacyAllowed = (config.allowed_groups || []).some(g => g.chat_id === chatId);
  const legacySmart = (config.smart_groups || []).some(g => g.chat_id === chatId);
  if (legacyAllowed || legacySmart) return true;

  return false;
}

function isSmartGroup(chatId) {
  const groupConfig = resolveGroupConfig(chatId);
  if (groupConfig) {
    return groupConfig.mode === 'smart' || groupConfig.requireMention === false;
  }
  return (config.smart_groups || []).some(g => g.chat_id === chatId);
}

function isSenderAllowedInGroup(chatId, senderUserId, senderOpenId) {
  const groupConfig = resolveGroupConfig(chatId);
  if (!groupConfig?.allowFrom || groupConfig.allowFrom.length === 0) {
    return true;
  }
  const allowed = groupConfig.allowFrom.map(s => String(s).toLowerCase());
  if (allowed.includes('*')) return true;
  if (senderUserId && allowed.includes(senderUserId.toLowerCase())) return true;
  if (senderOpenId && allowed.includes(senderOpenId.toLowerCase())) return true;
  return false;
}

function getGroupHistoryLimit(chatId) {
  const groupConfig = resolveGroupConfig(chatId);
  return groupConfig?.historyLimit || config.message?.context_messages || DEFAULT_HISTORY_LIMIT;
}

// Check if bot is mentioned
function isBotMentioned(mentions, botId) {
  if (!mentions || !Array.isArray(mentions)) return false;
  return mentions.some(m => {
    const mentionId = m.id?.open_id || m.id?.user_id || m.id?.app_id || '';
    return mentionId === botId || m.key === '@_all';
  });
}

/**
 * Resolve @_user_N placeholders in message text to real names.
 */
function resolveMentions(text, mentions, { stripBot = false, botOpenId: botId } = {}) {
  if (!text || !mentions || !Array.isArray(mentions) || mentions.length === 0) return text;

  let resolved = text;
  for (const m of mentions) {
    if (!m.key) continue;
    const isBotMention = botId && (m.id?.open_id === botId || m.id?.app_id === botId);
    if (stripBot && isBotMention) {
      resolved = resolved.replace(new RegExp(m.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'g'), '');
    } else if (m.name) {
      resolved = resolved.replace(m.key, `@${m.name}`);
    }
  }
  return resolved.trim();
}

/**
 * Parse c4-receive JSON response from stdout.
 */
function parseC4Response(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Send message to Claude via C4 (with 1 retry on unexpected failure)
 */
function sendToC4(source, endpoint, content, onReject) {
  if (!content) {
    console.error('[lark] sendToC4 called with empty content');
    return;
  }
  const safeContent = content.replace(/'/g, "'\\''");
  const cmd = `node "${C4_RECEIVE}" --channel "${source}" --endpoint "${endpoint}" --json --content '${safeContent}'`;

  exec(cmd, { encoding: 'utf8' }, (error, stdout) => {
    if (!error) {
      console.log(`[lark] Sent to C4: ${content.substring(0, 50)}...`);
      return;
    }
    const response = parseC4Response(error.stdout || stdout);
    if (response && response.ok === false && response.error?.message) {
      console.warn(`[lark] C4 rejected (${response.error.code}): ${response.error.message}`);
      if (onReject) onReject(response.error.message);
      return;
    }
    console.warn(`[lark] C4 send failed, retrying in 2s: ${error.message}`);
    setTimeout(() => {
      exec(cmd, { encoding: 'utf8' }, (retryError, retryStdout) => {
        if (!retryError) {
          console.log(`[lark] Sent to C4 (retry): ${content.substring(0, 50)}...`);
          return;
        }
        const retryResponse = parseC4Response(retryError.stdout || retryStdout);
        if (retryResponse && retryResponse.ok === false && retryResponse.error?.message) {
          console.error(`[lark] C4 rejected after retry (${retryResponse.error.code}): ${retryResponse.error.message}`);
          if (onReject) onReject(retryResponse.error.message);
        } else {
          console.error(`[lark] C4 send failed after retry: ${retryError.message}`);
        }
      });
    }, 2000);
  });
}

/**
 * Build structured endpoint string for C4.
 * Format: chatId|type:group|root:rootId|parent:parentId|msg:messageId|thread:threadId
 */
function buildEndpoint(chatId, { chatType, rootId, parentId, messageId, threadId } = {}) {
  let endpoint = chatId;
  if (chatType) {
    endpoint += `|type:${chatType}`;
  }
  if (rootId) {
    endpoint += `|root:${rootId}`;
  }
  if (parentId) {
    endpoint += `|parent:${parentId}`;
  }
  if (messageId) {
    endpoint += `|msg:${messageId}`;
  }
  if (threadId) {
    endpoint += `|thread:${threadId}`;
  }
  return endpoint;
}

/**
 * Fetch content of a quoted/replied message (best-effort).
 */
async function fetchQuotedMessage(messageId) {
  try {
    const { getClient } = await import('./lib/client.js');
    const client = getClient();
    const res = await client.im.message.get({
      path: { message_id: messageId },
    });
    if (res.code === 0 && res.data?.items?.[0]) {
      const msg = res.data.items[0];
      const senderId = msg.sender?.id;
      const senderName = await resolveUserName(senderId);
      const content = JSON.parse(msg.body?.content || '{}');
      let text;
      if (msg.msg_type === 'text') {
        text = content.text || '';
      } else if (msg.msg_type === 'post') {
        ({ text } = extractPostText(JSON.parse(msg.body?.content || '{}').content || [], messageId));
      } else {
        text = `[${msg.msg_type} message]`;
      }
      if (msg.mentions && msg.mentions.length > 0) {
        text = resolveMentions(text, msg.mentions);
      }
      return { sender: senderName, text };
    }
  } catch (err) {
    console.log(`[lark] Failed to fetch quoted message ${messageId}: ${err.message}`);
  }
  return null;
}

/**
 * Format message for C4 using XML-structured tags.
 */
function formatMessage(chatType, userName, text, contextMessages = [], mediaPath = null, { quotedContent, threadContext } = {}) {
  let prefix = chatType === 'p2p' ? '[Lark DM]' : '[Lark GROUP]';
  let parts = [`${prefix} ${userName} said: `];

  if (threadContext && threadContext.length > 0) {
    const contextLines = threadContext.map(m => `[${m.user_name || m.user_id}]: ${m.text}`).join('\n');
    parts.push(`<thread-context>\n${contextLines}\n</thread-context>\n\n`);
  } else if (contextMessages.length > 0) {
    const contextLines = contextMessages.map(m => `[${m.user_name || m.user_id}]: ${m.text}`).join('\n');
    parts.push(`<group-context>\n${contextLines}\n</group-context>\n\n`);
  }

  if (quotedContent && !threadContext) {
    const sender = quotedContent.sender || 'unknown';
    const quoted = quotedContent.text || '';
    parts.push(`<replying-to>\n[${sender}]: ${quoted}\n</replying-to>\n\n`);
  }

  parts.push(`<current-message>\n${text}\n</current-message>`);

  let message = parts.join('');

  if (mediaPath) {
    message += ` ---- file: ${mediaPath}`;
  }

  return message;
}

/**
 * Extract text from a Lark post (rich text) message.
 */
function extractPostText(paragraphs, messageId) {
  const imageKeys = [];
  const lines = [];

  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue;
    const parts = [];

    for (const el of paragraph) {
      switch (el.tag) {
        case 'text':
          parts.push(el.text || '');
          break;
        case 'at':
          parts.push(`@${el.user_name || el.user_id || 'unknown'}`);
          break;
        case 'a':
          if (el.href) {
            parts.push(`${el.text || ''}(${el.href})`);
          } else {
            parts.push(el.text || '');
          }
          break;
        case 'img':
          if (el.image_key) {
            imageKeys.push(el.image_key);
            parts.push(`[image, image_key: ${el.image_key}, msg_id: ${messageId}]`);
          }
          break;
        case 'media':
          parts.push(`[media, file_key: ${el.file_key || 'unknown'}, msg_id: ${messageId}]`);
          break;
        case 'emotion':
          parts.push(el.emoji_type ? `[${el.emoji_type}]` : '');
          break;
        default:
          if (el.text) parts.push(el.text);
          break;
      }
    }

    lines.push(parts.join(''));
  }

  return { text: lines.join('\n'), imageKeys };
}

// Extract content from Lark message
// Returns imageKeys as array (all images from post messages, or single image)
function extractMessageContent(message) {
  const msgType = message.message_type;
  const content = JSON.parse(message.content || '{}');

  switch (msgType) {
    case 'text':
      return { text: content.text || '', imageKeys: [], fileKey: null, fileName: null };
    case 'post': {
      if (content.content) {
        const { text, imageKeys } = extractPostText(content.content, message.message_id);
        const fullText = content.title ? `[${content.title}] ${text}` : text;
        return { text: fullText, imageKeys, fileKey: null, fileName: null };
      }
      return { text: '', imageKeys: [], fileKey: null, fileName: null };
    }
    case 'image':
      return { text: '', imageKeys: content.image_key ? [content.image_key] : [], fileKey: null, fileName: null };
    case 'file':
      return { text: '', imageKeys: [], fileKey: content.file_key, fileName: content.file_name || 'unknown' };
    default:
      return { text: `[${msgType} message]`, imageKeys: [], fileKey: null, fileName: null };
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

// Check whitelist
function isWhitelisted(userId, openId) {
  if (isOwner(userId, openId)) return true;
  if (!config.whitelist?.enabled) return true;
  const allowedUsers = [...(config.whitelist.private_users || []), ...(config.whitelist.group_users || [])];
  return allowedUsers.includes(userId) || (openId && allowedUsers.includes(openId));
}

/**
 * Handle im.message.receive_v1 event.
 */
async function handleMessageEvent(event) {
  const message = event.event.message;
  const sender = event.event.sender;
  const mentions = message.mentions;

  const senderUserId = sender.sender_id?.user_id;
  const senderOpenId = sender.sender_id?.open_id;
  const chatId = message.chat_id;
  const messageId = message.message_id;
  const chatType = message.chat_type;
  const rootId = message.root_id || null;
  const parentId = message.parent_id || null;
  const threadId = message.thread_id || null;

  // Dedup check
  if (isDuplicate(messageId)) return;

  const { text, imageKeys, fileKey, fileName } = extractMessageContent(message);
  console.log(`[lark] ${chatType} message from ${senderUserId}: ${(text || '').substring(0, 50) || '[media]'}...`);

  // Build log text with file/image metadata
  let logText = text;
  for (const imgKey of imageKeys) {
    const imageInfo = `[image, image_key: ${imgKey}, msg_id: ${messageId}]`;
    logText = logText ? `${logText}\n${imageInfo}` : imageInfo;
  }
  if (fileKey) {
    const fileInfo = `[file: ${fileName}, file_key: ${fileKey}, msg_id: ${messageId}]`;
    logText = logText ? `${logText}\n${fileInfo}` : fileInfo;
  }

  logMessage(chatType, chatId, senderUserId, senderOpenId, logText, messageId, event.header.create_time, mentions, threadId);

  // Build structured endpoint with routing metadata
  const endpoint = buildEndpoint(chatId, { chatType, rootId, parentId, messageId, threadId });

  let quotedContent = null;
  let threadContext = null;

  // Private chat handling
  if (chatType === 'p2p') {
    if (!config.owner?.bound) {
      await bindOwner(senderUserId, senderOpenId);
    }

    if (!isWhitelisted(senderUserId, senderOpenId)) {
      console.log(`[lark] Private message from non-whitelisted user ${senderUserId}, ignoring`);
      return;
    }

    addTypingIndicator(messageId);

    if (threadId) {
      threadContext = await getContextWithFallback(threadId, messageId, 'thread');
    } else if (parentId) {
      quotedContent = await fetchQuotedMessage(parentId);
    }

    const senderName = await resolveUserName(senderUserId);
    const cleanText = resolveMentions(text, mentions);
    const rejectReply = (errMsg) => {
      removeTypingIndicator(messageId);
      sendMessage(chatId, errMsg).catch(e => console.error('[lark] reject reply failed:', e.message));
    };

    if (imageKeys.length > 0) {
      const mediaPaths = [];
      for (const imgKey of imageKeys) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const localPath = path.join(MEDIA_DIR, `lark-${timestamp}-${imgKey.slice(-8)}.png`);
        const result = await downloadImage(messageId, imgKey, localPath);
        if (result.success) {
          mediaPaths.push(localPath);
        }
      }
      if (mediaPaths.length > 0) {
        const mediaLabel = mediaPaths.length === 1 ? '[image]' : `[${mediaPaths.length} images]`;
        const msg = formatMessage('p2p', senderName, `${mediaLabel}${cleanText ? ' ' + cleanText : ''}`, [], mediaPaths[0], { quotedContent, threadContext });
        sendToC4('lark', endpoint, msg, rejectReply);
      } else {
        const msg = formatMessage('p2p', senderName, '[image download failed]', [], null, { quotedContent, threadContext });
        sendToC4('lark', endpoint, msg, rejectReply);
      }
      return;
    }

    if (fileKey) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const localPath = path.join(MEDIA_DIR, `lark-${timestamp}-${fileName}`);
      const result = await downloadFile(messageId, fileKey, localPath);
      if (result.success) {
        const msg = formatMessage('p2p', senderName, `[file: ${fileName}]`, [], localPath, { quotedContent, threadContext });
        sendToC4('lark', endpoint, msg, rejectReply);
      } else {
        const msg = formatMessage('p2p', senderName, `[file download failed: ${fileName}]`, [], null, { quotedContent, threadContext });
        sendToC4('lark', endpoint, msg, rejectReply);
      }
      return;
    }

    const msg = formatMessage('p2p', senderName, cleanText, [], null, { quotedContent, threadContext });
    sendToC4('lark', endpoint, msg, rejectReply);
    return;
  }

  // Group chat handling
  if (chatType === 'group') {
    const mentioned = isBotMentioned(mentions, botOpenId);
    const smart = isSmartGroup(chatId);

    if (!isGroupAllowed(chatId)) {
      const senderIsOwner = isOwner(senderUserId, senderOpenId);
      if (!senderIsOwner) {
        console.log(`[lark] Group ${chatId} not allowed by policy, ignoring`);
        return;
      }
    }

    if (!smart && !mentioned) {
      console.log(`[lark] Group message without @mention, logged only`);
      return;
    }

    if (!isSenderAllowedInGroup(chatId, senderUserId, senderOpenId)) {
      const senderIsOwner = isOwner(senderUserId, senderOpenId);
      if (!senderIsOwner) {
        console.log(`[lark] Sender ${senderUserId} not in group ${chatId} allowFrom, ignoring`);
        return;
      }
    }

    if (!smart) {
      const senderIsOwner = isOwner(senderUserId, senderOpenId);
      if (!senderIsOwner && !isWhitelisted(senderUserId, senderOpenId)) {
        console.log(`[lark] @mention from non-whitelisted user ${senderUserId} in group, ignoring`);
        return;
      }
    }

    console.log(`[lark] ${smart ? 'Smart group' : 'Bot @mentioned in'} group ${chatId}`);
    const contextMessages = await getGroupContext(chatId, messageId);
    updateCursor(chatId, messageId);

    addTypingIndicator(messageId);

    if (threadId) {
      threadContext = await getContextWithFallback(threadId, messageId, 'thread');
    } else if (parentId) {
      quotedContent = await fetchQuotedMessage(parentId);
    }

    const senderName = await resolveUserName(senderUserId);
    const cleanText = resolveMentions(text, mentions);
    const groupRejectReply = (errMsg) => {
      removeTypingIndicator(messageId);
      sendMessage(chatId, errMsg).catch(e => console.error('[lark] reject reply failed:', e.message));
    };

    if (imageKeys.length > 0) {
      const mediaPaths = [];
      for (const imgKey of imageKeys) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const localPath = path.join(MEDIA_DIR, `lark-group-${timestamp}-${imgKey.slice(-8)}.png`);
        const result = await downloadImage(messageId, imgKey, localPath);
        if (result.success) {
          mediaPaths.push(localPath);
        }
      }
      if (mediaPaths.length > 0) {
        const mediaLabel = mediaPaths.length === 1 ? '[image]' : `[${mediaPaths.length} images]`;
        const msg = formatMessage('group', senderName, `${mediaLabel}${cleanText ? ' ' + cleanText : ''}`, contextMessages, mediaPaths[0], { quotedContent, threadContext });
        sendToC4('lark', endpoint, msg, groupRejectReply);
      } else {
        removeTypingIndicator(messageId);
      }
      return;
    }

    if (fileKey) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const localPath = path.join(MEDIA_DIR, `lark-group-${timestamp}-${fileName}`);
      const result = await downloadFile(messageId, fileKey, localPath);
      if (result.success) {
        const msg = formatMessage('group', senderName, `[file: ${fileName}]${cleanText ? ' ' + cleanText : ''}`, contextMessages, localPath, { quotedContent, threadContext });
        sendToC4('lark', endpoint, msg, groupRejectReply);
      } else {
        removeTypingIndicator(messageId);
      }
      return;
    }

    const msg = formatMessage('group', senderName, cleanText || text, contextMessages, null, { quotedContent, threadContext });
    sendToC4('lark', endpoint, msg, groupRejectReply);
  }
}

// Express app
const app = express();
app.use(express.json());

// Webhook endpoint
app.post('/webhook', (req, res) => {
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

  // Verify token (required)
  const verificationToken = config.bot?.verification_token;
  if (!verificationToken) {
    console.error('[lark] verification_token not configured — rejecting request. Set bot.verification_token in config.json.');
    return res.status(500).json({ error: 'Server misconfigured: verification_token missing' });
  }
  const eventToken = event.token || event.header?.token;
  if (eventToken !== verificationToken) {
    console.warn(`[lark] Verification token mismatch, rejecting request`);
    return res.status(403).json({ error: 'Token verification failed' });
  }

  // URL Verification Challenge
  if (event.type === 'url_verification') {
    console.log('[lark] URL verification challenge received');
    return res.json({ challenge: event.challenge });
  }

  // Respond immediately to prevent Lark retry (timeout ~15s)
  res.json({ code: 0 });

  // Handle message event asynchronously
  if (event.header?.event_type === 'im.message.receive_v1') {
    const messageId = event.event?.message?.message_id;
    if (isDuplicate(messageId)) return;

    handleMessageEvent(event).catch(err => {
      console.error(`[lark] Error handling message: ${err.message}`);
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'zylos-lark',
    cursors: Object.keys(groupCursors).length
  });
});

// Internal endpoint: record bot's outgoing messages into in-memory history
app.post('/internal/record-outgoing', (req, res) => {
  const { chatId, threadId, text, messageId } = req.body || {};
  if (!text) return res.status(400).json({ error: 'missing text' });
  const entry = {
    timestamp: new Date().toISOString(),
    message_id: messageId || `bot_${Date.now()}`,
    user_id: botOpenId || 'bot',
    user_name: botAppName || 'bot',
    text
  };
  if (threadId) {
    recordHistoryEntry(threadId, entry);
  } else if (chatId) {
    recordHistoryEntry(chatId, entry);
  }
  res.json({ ok: true });
});

// Graceful shutdown
function shutdown() {
  console.log(`[lark] Shutting down...`);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Startup check: verification_token is required
if (!config.bot?.verification_token) {
  console.error('[lark] FATAL: bot.verification_token is not configured.');
  console.error('[lark] Set it in ~/zylos/components/lark/config.json under bot.verification_token');
  console.error('[lark] Find it in the developer console: Event Subscriptions → Verification Token');
  process.exit(1);
}

// Fetch bot identity then start server
const PORT = config.webhook_port || 3457;

(async () => {
  try {
    const botInfo = await getBotInfo();
    if (botInfo.success) {
      botOpenId = botInfo.open_id;
      botAppName = botInfo.app_name || 'bot';
      console.log(`[lark] Bot identity: ${botAppName} (${botOpenId})`);
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
