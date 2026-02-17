#!/usr/bin/env node
/**
 * C4 Communication Bridge Interface for zylos-lark
 *
 * Usage:
 *   ./send.js <endpoint_id> "message text"
 *   ./send.js <endpoint_id> "[MEDIA:image]/path/to/image.png"
 *   ./send.js <endpoint_id> "[MEDIA:file]/path/to/document.pdf"
 *
 * Exit codes:
 *   0 - Success
 *   1 - Error
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig, DATA_DIR } from '../src/lib/config.js';
import { sendToGroup, sendMessage, uploadImage, sendImage, uploadFile, sendFile, replyToMessage } from '../src/lib/message.js';

const TYPING_DIR = path.join(DATA_DIR, 'typing');

const MAX_LENGTH = 2000;  // Lark message max length

// Parse arguments
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: send.js <endpoint_id> <message>');
  console.error('       send.js <endpoint_id> "[MEDIA:image]/path/to/image.png"');
  console.error('       send.js <endpoint_id> "[MEDIA:file]/path/to/file.pdf"');
  process.exit(1);
}

const rawEndpoint = args[0];
const message = args.slice(1).join(' ');

/**
 * Parse structured endpoint string.
 * Format: chatId|type:group|root:rootId|parent:parentId|msg:messageId|thread:threadId
 * Backward compatible: plain chatId without | works as before.
 */
function parseEndpoint(endpoint) {
  const parts = endpoint.split('|');
  const result = { chatId: parts[0] };
  for (const part of parts.slice(1)) {
    const colonIdx = part.indexOf(':');
    if (colonIdx > 0) {
      const key = part.substring(0, colonIdx);
      const value = part.substring(colonIdx + 1);
      result[key] = value;
    }
  }
  return result;
}

const parsedEndpoint = parseEndpoint(rawEndpoint);
const endpointId = parsedEndpoint.chatId;

// Check if component is enabled
const config = getConfig();
if (!config.enabled) {
  console.error('Error: lark is disabled in config');
  process.exit(1);
}

// Parse media prefix
const mediaMatch = message.match(/^\[MEDIA:(\w+)\](.+)$/);

/**
 * Split long message into chunks (markdown-aware).
 * Ensures code blocks (```) are not split across chunks.
 */
function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let breakAt = maxLength;

    // Check if we're inside a code block at the break point
    const segment = remaining.substring(0, breakAt);
    const fenceMatches = segment.match(/```/g);
    const insideCodeBlock = fenceMatches && fenceMatches.length % 2 !== 0;

    if (insideCodeBlock) {
      const lastFenceStart = segment.lastIndexOf('```');
      const lineBeforeFence = remaining.lastIndexOf('\n', lastFenceStart - 1);
      if (lineBeforeFence > maxLength * 0.2) {
        breakAt = lineBeforeFence;
      } else {
        const fenceEnd = remaining.indexOf('```', lastFenceStart + 3);
        if (fenceEnd !== -1) {
          const blockEnd = remaining.indexOf('\n', fenceEnd + 3);
          breakAt = blockEnd !== -1 ? blockEnd + 1 : fenceEnd + 3;
        }
        if (breakAt > maxLength) {
          breakAt = maxLength;
        }
      }
    } else {
      const chunk = remaining.substring(0, breakAt);

      const lastParaBreak = chunk.lastIndexOf('\n\n');
      if (lastParaBreak > maxLength * 0.3) {
        breakAt = lastParaBreak + 1;
      } else {
        const lastNewline = chunk.lastIndexOf('\n');
        if (lastNewline > maxLength * 0.3) {
          breakAt = lastNewline;
        } else {
          const lastSpace = chunk.lastIndexOf(' ');
          if (lastSpace > maxLength * 0.3) {
            breakAt = lastSpace;
          }
        }
      }
    }

    chunks.push(remaining.substring(0, breakAt).trim());
    remaining = remaining.substring(breakAt).trim();
  }

  return chunks;
}

/**
 * Send text message with auto-chunking.
 * Routing logic (unified for DM and group):
 *   - Topic/reply (root exists): ALL chunks reply to parent||root (stay in thread)
 *   - Group @mention (no root): first chunk replies to msg, rest use sendToGroup
 *   - DM (no root): sendMessage directly
 *   - Fallback: sendToGroup
 * Reply failures fall back to sendMessage (DM) or sendToGroup (group).
 */
async function sendText(endpoint, text) {
  const chunks = splitMessage(text, MAX_LENGTH);
  const { chatId, root, parent, msg, type } = parsedEndpoint;
  const isDM = type === 'p2p';
  const isGroup = type === 'group';

  for (let i = 0; i < chunks.length; i++) {
    let result;
    const isFirstChunk = i === 0;

    if (root) {
      // Topic/reply thread: ALL chunks stay in topic (DM and group alike)
      const replyTarget = parent || root;
      try {
        result = await replyToMessage(replyTarget, chunks[i]);
      } catch (err) {
        console.log('[lark] Reply threw, falling back:', err.message);
        result = { success: false };
      }
      if (!result.success) {
        console.log('[lark] Reply failed, falling back:', result.message);
        result = isDM
          ? await sendMessage(chatId, chunks[i], 'chat_id', 'text')
          : await sendToGroup(endpoint, chunks[i]);
      }
    } else if (isFirstChunk && msg && isGroup) {
      // Group @mention: first chunk replies to trigger message
      try {
        result = await replyToMessage(msg, chunks[i]);
      } catch (err) {
        console.log('[lark] Reply threw, falling back to sendToGroup:', err.message);
        result = { success: false };
      }
      if (!result.success) {
        console.log('[lark] Reply failed, falling back to sendToGroup:', result.message);
        result = await sendToGroup(endpoint, chunks[i]);
      }
    } else if (isDM) {
      // DM without topic/reply: send directly
      result = await sendMessage(chatId, chunks[i], 'chat_id', 'text');
    } else {
      // Fallback: send to group/chat directly
      result = await sendToGroup(endpoint, chunks[i]);
    }

    if (!result.success) {
      throw new Error(result.message);
    }
    // Small delay between chunks
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  if (chunks.length > 1) {
    console.log(`Sent ${chunks.length} chunks`);
  }
}

/**
 * Send media (image or file).
 * Thread-aware: in topic threads, reply to parent||root to stay in topic.
 */
async function sendMedia(type, filePath) {
  const trimmedPath = filePath.trim();
  const { chatId, root, parent, msg, type: chatType } = parsedEndpoint;
  const replyTarget = root ? (parent || root) : (msg && chatType === 'group' ? msg : null);

  if (type === 'image') {
    const uploadResult = await uploadImage(trimmedPath);
    if (!uploadResult.success) {
      throw new Error(`Failed to upload image: ${uploadResult.message}`);
    }
    if (replyTarget) {
      try {
        const result = await replyToMessage(replyTarget, JSON.stringify({ image_key: uploadResult.imageKey }), 'image');
        if (result.success) return;
        console.log('[lark] Image reply failed, falling back to sendImage:', result.message);
      } catch (err) {
        console.log('[lark] Image reply threw, falling back:', err.message);
      }
    }
    const sendResult = await sendImage(chatId, uploadResult.imageKey);
    if (!sendResult.success) {
      throw new Error(`Failed to send image: ${sendResult.message}`);
    }
  } else if (type === 'file') {
    const uploadResult = await uploadFile(trimmedPath);
    if (!uploadResult.success) {
      throw new Error(`Failed to upload file: ${uploadResult.message}`);
    }
    if (replyTarget) {
      try {
        const result = await replyToMessage(replyTarget, JSON.stringify({ file_key: uploadResult.fileKey }), 'file');
        if (result.success) return;
        console.log('[lark] File reply failed, falling back to sendFile:', result.message);
      } catch (err) {
        console.log('[lark] File reply threw, falling back:', err.message);
      }
    }
    const sendResult = await sendFile(chatId, uploadResult.fileKey);
    if (!sendResult.success) {
      throw new Error(`Failed to send file: ${sendResult.message}`);
    }
  } else {
    throw new Error(`Unsupported media type: ${type}`);
  }
}

/**
 * Write a typing-done marker file so index.js can remove the typing indicator.
 */
function markTypingDone(msgId) {
  if (!msgId) return;
  try {
    fs.mkdirSync(TYPING_DIR, { recursive: true });
    fs.writeFileSync(path.join(TYPING_DIR, `${msgId}.done`), String(Date.now()));
  } catch {
    // Non-critical
  }
}

/**
 * Notify index.js to record the bot's outgoing message into in-memory history.
 */
async function recordOutgoing(text) {
  const port = config.webhook_port || 3457;
  const body = JSON.stringify({
    chatId: parsedEndpoint.chatId,
    threadId: parsedEndpoint.thread || null,
    text
  });
  try {
    await fetch(`http://127.0.0.1:${port}/internal/record-outgoing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': process.env.LARK_APP_ID || '',
      },
      body
    });
  } catch { /* non-critical */ }
}

async function send() {
  try {
    if (mediaMatch) {
      const [, mediaType, mediaPath] = mediaMatch;
      await sendMedia(mediaType, mediaPath);
    } else {
      await sendText(endpointId, message);
      await recordOutgoing(message);
    }
    markTypingDone(parsedEndpoint.msg);
    console.log('Message sent successfully');
    process.exit(0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

send();
