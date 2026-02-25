#!/usr/bin/env node
/**
 * zylos-lark media download by resource key
 *
 * Usage:
 *   node download.js image <message_id> <image_key>
 *   node download.js file  <message_id> <file_key> [filename]
 *
 * Downloads an image or file from Lark using message_id + resource key.
 * These keys come from message metadata logged in smart group context.
 *
 * Outputs the local file path on success.
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { downloadImage, downloadFile } from '../src/lib/message.js';
import { DATA_DIR } from '../src/lib/config.js';

const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error('Usage:');
  console.error('  node download.js image <message_id> <image_key>');
  console.error('  node download.js file  <message_id> <file_key> [filename]');
  console.error('');
  console.error('  message_id - Lark message ID (e.g., om_xxx)');
  console.error('  image_key  - Image resource key from message metadata');
  console.error('  file_key   - File resource key from message metadata');
  console.error('  filename   - Optional output filename (default: auto-generated)');
  process.exit(1);
}

const type = args[0];
const messageId = args[1];
const resourceKey = args[2];
const filenameHint = args[3] || '';

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const safeKey = resourceKey.replace(/[^a-zA-Z0-9_-]/g, '').slice(-8);

if (type === 'image') {
  const localPath = path.join(MEDIA_DIR, `lark-dl-${timestamp}-${safeKey}.png`);
  const result = await downloadImage(messageId, resourceKey, localPath);
  if (result.success) {
    console.log(result.path);
  } else {
    console.error(`Error: ${result.message}`);
    process.exit(1);
  }
} else if (type === 'file') {
  const safeName = filenameHint
    ? filenameHint.replace(/[^a-zA-Z0-9_.\-]/g, '_').slice(0, 128)
    : `lark-dl-${timestamp}-${safeKey}.bin`;
  const localPath = path.join(MEDIA_DIR, safeName);
  const result = await downloadFile(messageId, resourceKey, localPath);
  if (result.success) {
    console.log(result.path);
  } else {
    console.error(`Error: ${result.message}`);
    process.exit(1);
  }
} else {
  console.error(`Unknown type: ${type}. Use "image" or "file".`);
  process.exit(1);
}
