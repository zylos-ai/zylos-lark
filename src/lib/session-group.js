/**
 * Session-group mapping for zylos-core multi-session mode.
 *
 * The group name is derived only from the reply endpoint, so the inbound
 * `--session-group` value and `scripts/session-group.js <endpoint>` always
 * agree. Rules:
 *   private chat (type:p2p)               -> dm-<chat_id>                       (threads not split)
 *   group chat (type:group), no thread    -> group-<chat_id>                    (incl. quote/reply chains)
 *   group chat (type:group) with thread   -> group-<chat_id>:topic-<thread_id>
 *
 * These names are Core's memory keys. The rules are FIXED once live: changing
 * them needs a migration planned together with Core, otherwise existing
 * groups lose their memory.
 *
 * Per-message parts of the endpoint (msg, root, parent) never take part.
 * Nothing is guessed, rewritten, truncated or hashed: an endpoint without a
 * known type, an id with unexpected characters, or a name Core would reject
 * throws. The component never adds the `lark:` namespace; Core does.
 */
import { parseEndpoint } from './endpoint.js';

/** Core's limits for the name a component passes (Core adds `<namespace>:`). */
export const SESSION_GROUP_MAX_LENGTH = 95;
export const SESSION_GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/** Lark ids (oc_..., omt_...) used verbatim inside group names. */
const LARK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Whether Core would accept this nonempty name.
 * @param {string} name
 * @returns {boolean}
 */
export function isValidSessionGroup(name) {
  return typeof name === 'string' && name.length <= SESSION_GROUP_MAX_LENGTH
    && SESSION_GROUP_PATTERN.test(name);
}

const quote = (value, max = 64) => JSON.stringify(String(value ?? '').slice(0, max));

/**
 * Derive the in-group session name from an endpoint string.
 * @param {string} endpoint - e.g. "oc_abc|type:group|msg:om_1|thread:omt_2"
 * @returns {string} group name without namespace (never '')
 * @throws {Error} when the endpoint cannot be mapped
 */
export function sessionGroupFromEndpoint(endpoint) {
  const parsed = parseEndpoint(endpoint);
  const chatId = parsed.chatId;
  if (!LARK_ID.test(chatId)) {
    throw new Error(`invalid Lark chat id in endpoint: ${quote(endpoint)}`);
  }

  let name;
  if (parsed.type === 'p2p') {
    name = `dm-${chatId}`;
  } else if (parsed.type === 'group') {
    const thread = parsed.thread;
    if (thread === undefined) {
      name = `group-${chatId}`;
    } else if (!LARK_ID.test(thread)) {
      throw new Error(`invalid thread id in endpoint: ${quote(thread, 32)}`);
    } else {
      name = `group-${chatId}:topic-${thread}`;
    }
  } else if (parsed.type === undefined) {
    throw new Error(`endpoint has no type, cannot tell DM from group: ${quote(endpoint)}`);
  } else {
    throw new Error(`unknown chat type in endpoint: ${quote(parsed.type, 32)}`);
  }

  if (!isValidSessionGroup(name)) {
    throw new Error(`session group would be invalid for Core (length ${name.length}, max ${SESSION_GROUP_MAX_LENGTH})`);
  }
  return name;
}
