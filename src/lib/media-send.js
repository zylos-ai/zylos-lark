/**
 * Thread-aware outbound media (image/file) routing.
 *
 * Prefers the system `lark-cli` for upload+send/reply (single atomic call),
 * and falls back to the pre-existing direct-API path in message.js if lark-cli
 * fails or is absent — so outbound media is never lost ("fallback A").
 *
 * Routing (unchanged from the previous direct-API-only implementation):
 *   - A reply target (group thread root/parent, or group @mention msg) →
 *     reply-to via lark-cli; direct-API reply flow is the fallback.
 *   - No reply target (p2p DM / plain group) → send to chat via lark-cli;
 *     direct-API send is the fallback.
 *
 * The direct-API fallbacks reproduce the exact prior behavior, including the
 * secondary "reply to root" attempt and the final "send to chat" fallback, so
 * media is delivered even when threaded reply fails.
 *
 * Everything is injectable via `deps` for testing.
 */

import { chooseReplyTarget } from './reply-target.js';
import { sendMedia as larkSendMedia, replyMedia as larkReplyMedia } from './lark-cli-bridge.js';
import {
  uploadImage as directUploadImage,
  uploadFile as directUploadFile,
  sendImage as directSendImage,
  sendFile as directSendFile,
  replyToMessage as directReplyToMessage,
} from './message.js';

/**
 * Direct-API upload + send to a chat (no reply). Resolves on success, throws
 * on hard failure. This is the fallback for the no-reply-target path.
 */
export async function directSendMedia({ chatId, type, path: filePath }, deps = {}) {
  const {
    uploadImage = directUploadImage,
    uploadFile = directUploadFile,
    sendImage = directSendImage,
    sendFile = directSendFile,
  } = deps;

  if (type === 'image') {
    const up = await uploadImage(filePath);
    if (!up.success) throw new Error(`Failed to upload image: ${up.message}`);
    const s = await sendImage(chatId, up.imageKey);
    if (!s.success) throw new Error(`Failed to send image: ${s.message}`);
    return { success: true, via: 'direct-api', messageId: s.messageId };
  }
  const up = await uploadFile(filePath);
  if (!up.success) throw new Error(`Failed to upload file: ${up.message}`);
  const s = await sendFile(chatId, up.fileKey);
  if (!s.success) throw new Error(`Failed to send file: ${s.message}`);
  return { success: true, via: 'direct-api', messageId: s.messageId };
}

/**
 * Direct-API upload + threaded reply, with the exact prior fallback chain:
 *   reply(target) → [reply(root) if parent!==root] → send(chatId).
 * Resolves on success, throws on hard failure. Fallback for the reply path.
 */
export async function directReplyMedia({ chatId, root, parent, replyTarget, type, path: filePath }, deps = {}) {
  const {
    uploadImage = directUploadImage,
    uploadFile = directUploadFile,
    sendImage = directSendImage,
    sendFile = directSendFile,
    replyToMessage = directReplyToMessage,
  } = deps;

  const isImage = type === 'image';
  const up = isImage ? await uploadImage(filePath) : await uploadFile(filePath);
  if (!up.success) throw new Error(`Failed to upload ${type}: ${up.message}`);
  const key = isImage ? up.imageKey : up.fileKey;
  const content = JSON.stringify(isImage ? { image_key: key } : { file_key: key });

  const tryRootReply = async () => {
    if (parent && root && parent !== root) {
      try {
        const rr = await replyToMessage(root, content, type);
        if (rr.success) return { success: true, via: 'direct-api', messageId: rr.messageId };
        console.log(`[lark] ${type} root reply fallback failed, falling back to send:`, rr.message);
      } catch (err) {
        console.log(`[lark] ${type} root reply threw, falling back to send:`, err.message);
      }
    }
    return null;
  };

  try {
    const r = await replyToMessage(replyTarget, content, type);
    if (r.success) return { success: true, via: 'direct-api', messageId: r.messageId };
    console.log(`[lark] ${type} reply failed, falling back:`, r.message);
    const viaRoot = await tryRootReply();
    if (viaRoot) return viaRoot;
  } catch (err) {
    console.log(`[lark] ${type} reply threw, falling back:`, err.message);
    const viaRoot = await tryRootReply();
    if (viaRoot) return viaRoot;
  }

  const s = isImage ? await sendImage(chatId, key) : await sendFile(chatId, key);
  if (!s.success) throw new Error(`Failed to send ${type}: ${s.message}`);
  return { success: true, via: 'direct-api', messageId: s.messageId };
}

/**
 * Route an outbound media (image/file) through lark-cli, with the direct-API
 * path as fallback. Resolves on success, throws on hard failure.
 *
 * @param {object} args
 * @param {object} args.endpoint  parsed endpoint ({ chatId, type, root, parent, msg })
 * @param {'image'|'file'} args.type
 * @param {string} args.path      local media path (absolute ok)
 * @param {object} [deps]  injectable bridge/direct helpers + chooseReplyTarget for tests
 * @returns {Promise<object>} normalized send result
 */
export async function sendMediaThreadAware({ endpoint, type, path: filePath }, deps = {}) {
  if (type !== 'image' && type !== 'file') {
    throw new Error(`Unsupported media type: ${type}`);
  }
  const {
    larkReply = larkReplyMedia,
    larkSend = larkSendMedia,
    directReply = directReplyMedia,
    directSend = directSendMedia,
    chooseTarget = chooseReplyTarget,
  } = deps;

  const { chatId, root, parent } = endpoint;
  const replyTarget = chooseTarget(endpoint);

  if (replyTarget) {
    return larkReply(
      { messageId: replyTarget, kind: type, path: filePath, replyInThread: !!root },
      () => directReply({ chatId, root, parent, replyTarget, type, path: filePath }),
    );
  }
  return larkSend(
    { chatId, kind: type, path: filePath },
    () => directSend({ chatId, type, path: filePath }),
  );
}
