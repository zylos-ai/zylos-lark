// Lark re-pushes an event it did not see acknowledged. Re-deliveries have
// arrived about 5 minutes, 1 hour and 7 hours after the original message
// (#85, #106), so an id must be remembered past the last of them.
export const MESSAGE_DEDUP_TTL_MS = 12 * 60 * 60 * 1000;
export const MESSAGE_DEDUP_SWEEP_THRESHOLD = 200;

export function createMessageDeduper({
  ttlMs = MESSAGE_DEDUP_TTL_MS,
  sweepThreshold = MESSAGE_DEDUP_SWEEP_THRESHOLD,
  now = () => Date.now(),
  logDuplicate = () => {},
} = {}) {
  const processedMessages = new Map();

  function isExpired(timestamp, currentTime) {
    return currentTime - timestamp > ttlMs;
  }

  // Every id is (re-)inserted with the current time and an expired id is
  // deleted before it is added again, so Map order is oldest first: stop at
  // the first id that has not expired.
  function sweepExpired(currentTime = now()) {
    for (const [messageId, timestamp] of processedMessages) {
      if (!isExpired(timestamp, currentTime)) break;
      processedMessages.delete(messageId);
    }
  }

  function checkAndMark(messageId) {
    if (!messageId) return false;

    const currentTime = now();
    const existingTimestamp = processedMessages.get(messageId);
    if (existingTimestamp !== undefined) {
      if (!isExpired(existingTimestamp, currentTime)) {
        logDuplicate(messageId);
        return true;
      }
      processedMessages.delete(messageId);
    }

    processedMessages.set(messageId, currentTime);
    if (processedMessages.size > sweepThreshold) {
      sweepExpired(currentTime);
    }
    return false;
  }

  return {
    checkAndMark,
    sweepExpired,
    size: () => processedMessages.size,
  };
}
