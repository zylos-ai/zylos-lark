/**
 * Domain resolution for Lark (international) vs Feishu (China).
 *
 * IMPORTANT: `lark.Domain.Feishu === 0` is a *falsy* enum value, so a naive
 * `DOMAIN_MAP[key] || lark.Domain.Lark` fallback silently falls through to
 * Lark International for `feishu` configs. That points Feishu credentials at
 * the larksuite.com endpoint, which the WebSocket long connection rejects with
 * `code: 1000040351, system busy`. Use an explicit key-presence check instead.
 */

import * as lark from '@larksuiteoapi/node-sdk';

export const DOMAIN_MAP = {
  feishu: lark.Domain.Feishu,
  lark: lark.Domain.Lark,
};

/**
 * Resolve a config domain key to the SDK Domain value.
 * Falls back to Lark International only for unknown/missing keys — a known key
 * whose value is falsy (e.g. `feishu` → 0) is honored, not overridden.
 *
 * @param {string} domainKey - 'feishu' | 'lark'
 * @returns {string|number} lark.Domain value
 */
export function resolveDomain(domainKey) {
  return domainKey in DOMAIN_MAP ? DOMAIN_MAP[domainKey] : lark.Domain.Lark;
}
