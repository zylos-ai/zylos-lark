/**
 * Receive-id typing for outbound DM sends.
 *
 * A DM endpoint can carry either a chat id (`oc_...`) or the peer's open id
 * (`ou_...`). The Lark send API needs `receive_id_type` to match the id it is
 * given, so callers must not assume one form: addresses persisted by earlier
 * versions, scheduled tasks and stored address books all carry open ids.
 */

/**
 * Resolve the `receive_id_type` for a DM endpoint id.
 *
 * @param {string} endpointId Endpoint id (chat id or open id).
 * @returns {'open_id'|'chat_id'} Matching receive_id_type.
 */
export function resolveDmReceiveIdType(endpointId) {
  return typeof endpointId === 'string' && endpointId.startsWith('ou_')
    ? 'open_id'
    : 'chat_id';
}
