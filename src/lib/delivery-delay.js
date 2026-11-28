/**
 * Delayed-delivery notice for inbound messages (#106).
 *
 * Lark re-pushes an event it did not see acknowledged, e.g. after a half-open
 * WebSocket or an outage, so a message can reach zylos-lark hours after it was
 * sent (re-pushes have arrived about 1 and 7 hours late). Without a marker the
 * agent answers it as if it had just been asked. When a message is older than
 * the threshold, its text in <current-message> starts with
 *
 *   [delayed delivery: sent 2026-09-24 03:20 UTC, 7h05m ago]
 *
 * so the agent can tell it is from earlier and check whether it still matters.
 *
 * The threshold is `message.delayed_delivery_minutes` in config.json (default
 * 10). 0 disables the notice; a negative or non-numeric value means the
 * default. The send time is the message's `create_time` (falling back to the
 * event header's), compared with the local clock, so the default leaves room
 * for clock skew; a send time in the future never gets a notice.
 */

export const DEFAULT_DELAYED_DELIVERY_MINUTES = 10;

/**
 * Threshold from `message.delayed_delivery_minutes`.
 * @param {*} value - config value (number or numeric string)
 * @returns {number|null} milliseconds, or null when the notice is disabled
 */
export function delayThresholdMs(value) {
  const fallback = DEFAULT_DELAYED_DELIVERY_MINUTES * 60_000;
  if (value === undefined || value === null || value === '') return fallback;
  const minutes = Number(value);
  if (minutes === 0) return null;
  if (!Number.isFinite(minutes) || minutes < 0) return fallback;
  return minutes * 60_000;
}

/**
 * When the message was sent: `message.create_time`, else the event header's
 * `create_time` (Lark sends both as millisecond timestamps in strings).
 * @param {object} [message] - event.message
 * @param {object} [header] - event.header
 * @returns {number|null} epoch milliseconds, or null when neither is usable
 */
export function messageSentAt(message, header) {
  for (const value of [message?.create_time, header?.create_time]) {
    if (/^\d+$/.test(String(value ?? '')) && Number(value) > 0) return Number(value);
  }
  return null;
}

/**
 * Compact duration: 45s, 12m, 7h05m, 2d03h.
 * @param {number} ms - non-negative
 * @returns {string}
 */
export function formatDelay(ms) {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`;
}

/**
 * Notice for a message delivered later than the threshold.
 * @param {number|null} sentAt - epoch milliseconds (see messageSentAt)
 * @param {object} [opts]
 * @param {number} [opts.now] - epoch milliseconds, defaults to Date.now()
 * @param {number|null} [opts.thresholdMs] - see delayThresholdMs; null disables
 * @returns {string|null} e.g. "[delayed delivery: sent 2026-09-24 03:20 UTC, 7h05m ago]"
 */
export function delayedDeliveryNotice(sentAt, {
  now = Date.now(),
  thresholdMs = DEFAULT_DELAYED_DELIVERY_MINUTES * 60_000,
} = {}) {
  if (sentAt == null || thresholdMs == null) return null;
  const delay = now - sentAt;
  if (!(delay > thresholdMs)) return null;
  const sent = new Date(sentAt).toISOString().slice(0, 16).replace('T', ' ');
  return `[delayed delivery: sent ${sent} UTC, ${formatDelay(delay)} ago]`;
}
