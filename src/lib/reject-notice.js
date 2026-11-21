/**
 * Deliver a C4 rejection notice (TRY_LATER / MAYBE_LOST) into the conversation
 * the triggering message came from.
 *
 * Routing matches the outbound send path (`chooseReplyTarget` + `reply_in_thread`
 * in scripts/send.js):
 * - p2p outside a topic thread: base send to the chat. A reply-to in a p2p DM is
 *   not surfaced in the main DM view (the API returns code:0 but the user never
 *   sees it), so quote-replies (parent/root without thread) must not reply-to.
 * - p2p inside a topic thread (`threadId` set): reply to parent||root with
 *   `reply_in_thread: true` so the notice lands in the thread the user is reading.
 * - group: reply to parent||root, or to the triggering message when it is in a
 *   thread; otherwise base send (unchanged).
 * A failed reply falls back to the base send.
 *
 * @param {object} msg
 * @param {string} msg.chatId
 * @param {string} msg.text
 * @param {string} [msg.chatType] - 'p2p' | 'group'
 * @param {string} [msg.rootId]
 * @param {string} [msg.parentId]
 * @param {string} [msg.threadId]
 * @param {string} [msg.messageId]
 * @param {object} deps
 * @param {(target: string, text: string, msgType?: string, opts?: { replyInThread?: boolean }) => Promise<{ success?: boolean }>} deps.replyToMessage
 * @param {(chatId: string, text: string) => Promise<{ success?: boolean }>} deps.sendMessage
 * @returns {Promise<boolean>} whether the notice was delivered
 */
import { chooseReplyTarget } from './reply-target.js';

export function chooseRejectTarget({ chatType, rootId, parentId, threadId, messageId } = {}) {
  if (chatType !== 'group') {
    return chooseReplyTarget({ type: chatType, root: rootId, parent: parentId, thread: threadId });
  }
  return parentId || rootId || (threadId ? messageId : null);
}

export async function deliverRejectNotice(
  { chatId, text, chatType, rootId, parentId, threadId, messageId } = {},
  { replyToMessage, sendMessage } = {},
) {
  const target = chooseRejectTarget({ chatType, rootId, parentId, threadId, messageId });
  if (target) {
    try {
      const r = await replyToMessage(target, text, 'text', { replyInThread: Boolean(threadId) });
      if (r && r.success) return true;
    } catch {
      // fall through to the base send below
    }
  }
  const result = await sendMessage(chatId, text);
  return !!(result && result.success);
}
