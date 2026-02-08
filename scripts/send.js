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
import path from 'path';
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig } from '../src/lib/config.js';
import { sendToGroup, uploadImage, sendImage, uploadFile, sendFile } from '../src/lib/message.js';

const MAX_LENGTH = 2000;  // Lark message max length

// Parse arguments
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: send.js <endpoint_id> <message>');
  console.error('       send.js <endpoint_id> "[MEDIA:image]/path/to/image.png"');
  console.error('       send.js <endpoint_id> "[MEDIA:file]/path/to/file.pdf"');
  process.exit(1);
}

const endpointId = args[0];
const message = args.slice(1).join(' ');

// Check if component is enabled
const config = getConfig();
if (!config.enabled) {
  console.error('Error: lark is disabled in config');
  process.exit(1);
}

// Parse media prefix
const mediaMatch = message.match(/^\[MEDIA:(\w+)\](.+)$/);

/**
 * Split long message into chunks
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

    let chunk = remaining.substring(0, maxLength);
    let breakAt = maxLength;

    // Try to break at last newline
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline > maxLength * 0.3) {
      breakAt = lastNewline;
    } else {
      // Try to break at last space
      const lastSpace = chunk.lastIndexOf(' ');
      if (lastSpace > maxLength * 0.3) {
        breakAt = lastSpace;
      }
    }

    chunks.push(remaining.substring(0, breakAt).trim());
    remaining = remaining.substring(breakAt).trim();
  }

  return chunks;
}

/**
 * Send text message with auto-chunking
 */
async function sendText(endpoint, text) {
  const chunks = splitMessage(text, MAX_LENGTH);

  for (let i = 0; i < chunks.length; i++) {
    const result = await sendToGroup(endpoint, chunks[i]);
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
 * Send media (image or file)
 */
async function sendMedia(endpoint, type, filePath) {
  const trimmedPath = filePath.trim();

  if (type === 'image') {
    const uploadResult = await uploadImage(trimmedPath);
    if (!uploadResult.success) {
      throw new Error(`Failed to upload image: ${uploadResult.message}`);
    }
    const sendResult = await sendImage(endpoint, uploadResult.imageKey);
    if (!sendResult.success) {
      throw new Error(`Failed to send image: ${sendResult.message}`);
    }
  } else if (type === 'file') {
    const uploadResult = await uploadFile(trimmedPath);
    if (!uploadResult.success) {
      throw new Error(`Failed to upload file: ${uploadResult.message}`);
    }
    const sendResult = await sendFile(endpoint, uploadResult.fileKey);
    if (!sendResult.success) {
      throw new Error(`Failed to send file: ${sendResult.message}`);
    }
  } else {
    throw new Error(`Unsupported media type: ${type}`);
  }
}

async function send() {
  try {
    if (mediaMatch) {
      const [, mediaType, mediaPath] = mediaMatch;
      await sendMedia(endpointId, mediaType, mediaPath);
    } else {
      await sendText(endpointId, message);
    }
    console.log('Message sent successfully');
    process.exit(0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

send();
