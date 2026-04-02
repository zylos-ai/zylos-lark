export const MESSAGE_DEDUP_TTL_MS = 5 * 60 * 1000;
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

  function sweepExpired(currentTime = now()) {
    for (const [messageId, timestamp] of processedMessages) {
      if (isExpired(timestamp, currentTime)) {
        processedMessages.delete(messageId);
      }
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
