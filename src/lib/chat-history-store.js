// In-memory recent-message history per group chat / thread, used for reply
// context. Bounded in two dimensions:
//   - per key: entries are trimmed back to `limit` once they exceed 2 * limit
//   - key count: at most `maxChats` keys (least-recently-used evicted), and
//     keys idle (no record or read) for longer than `idleTtlMs` are dropped.
//
// Recency is tracked with Map insertion order: every record/get moves the key
// to the end (delete + set), so the first key is always the least recently
// used one. That makes both LRU eviction and the idle sweep O(evicted).

export const DEFAULT_HISTORY_MAX_CHATS = 500;
export const DEFAULT_HISTORY_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

function resolvePositive(value, fallback) {
  const resolved = typeof value === 'function' ? value() : value;
  const n = Number(resolved);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * @param {object} [options]
 * @param {number|() => number} [options.maxChats] - max number of keys (default 500)
 * @param {number|() => number} [options.idleTtlMs] - idle expiry in ms (default 24h)
 * @param {() => number} [options.now] - clock, injectable for tests
 * @param {(key: string, reason: 'lru'|'idle') => void} [options.onEvict]
 */
export function createChatHistoryStore({
  maxChats = DEFAULT_HISTORY_MAX_CHATS,
  idleTtlMs = DEFAULT_HISTORY_IDLE_TTL_MS,
  now = () => Date.now(),
  onEvict = () => {},
} = {}) {
  // key -> { entries: object[], lastAccess: number }
  const histories = new Map();

  const getMaxChats = () => Math.floor(resolvePositive(maxChats, DEFAULT_HISTORY_MAX_CHATS)) || DEFAULT_HISTORY_MAX_CHATS;
  const getIdleTtlMs = () => resolvePositive(idleTtlMs, DEFAULT_HISTORY_IDLE_TTL_MS);

  function normalizeKey(key) {
    return key === undefined || key === null ? '' : String(key);
  }

  function evict(key, reason) {
    histories.delete(key);
    try { onEvict(key, reason); } catch {}
  }

  function touch(key, slot, currentTime) {
    slot.lastAccess = currentTime;
    histories.delete(key);
    histories.set(key, slot);
  }

  /** Drop keys idle longer than the TTL. Returns the number evicted. */
  function sweep(currentTime = now()) {
    const ttl = getIdleTtlMs();
    let evicted = 0;
    // Oldest-first order: stop at the first key that is still fresh.
    for (const [key, slot] of histories) {
      if (currentTime - slot.lastAccess <= ttl) break;
      evict(key, 'idle');
      evicted++;
    }
    return evicted;
  }

  function enforceCap() {
    const cap = getMaxChats();
    while (histories.size > cap) {
      const oldestKey = histories.keys().next().value;
      evict(oldestKey, 'lru');
    }
  }

  /**
   * Append an entry to a key's history (deduped by message_id) and trim the
   * key back to `limit` entries once it exceeds 2 * limit.
   */
  function record(key, entry, limit) {
    const k = normalizeKey(key);
    const currentTime = now();
    sweep(currentTime);

    let slot = histories.get(k);
    if (!slot) {
      slot = { entries: [], lastAccess: currentTime };
    }
    touch(k, slot, currentTime);

    // Deduplicate by message_id (lazy load + real-time can overlap)
    if (!(entry.message_id && slot.entries.some(m => m.message_id === entry.message_id))) {
      slot.entries.push(entry);
      // Coerce like the old inline code did: a hand-edited "10" still trims.
      const n = Number(limit);
      if (Number.isFinite(n) && n > 0 && slot.entries.length > n * 2) {
        slot.entries = slot.entries.slice(-n);
      }
    }

    enforceCap();
  }

  /**
   * Return the full (untrimmed-by-window) history array for a key, refreshing
   * its recency. Returns undefined when the key is unknown or has expired.
   */
  function get(key) {
    const k = normalizeKey(key);
    const slot = histories.get(k);
    if (!slot) return undefined;
    const currentTime = now();
    if (currentTime - slot.lastAccess > getIdleTtlMs()) {
      evict(k, 'idle');
      return undefined;
    }
    touch(k, slot, currentTime);
    return slot.entries;
  }

  return {
    record,
    get,
    sweep,
    has: (key) => histories.has(normalizeKey(key)),
    keys: () => [...histories.keys()],
    size: () => histories.size,
  };
}
