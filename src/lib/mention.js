/**
 * Helpers for preserving outgoing Lark @mentions.
 */

const LARK_AT_TAG_RE = /<at\s+user_id=(["'])(?:ou_[^"']+|all)\1[^>]*>/i;

export function hasLarkAtTag(text) {
  return LARK_AT_TAG_RE.test(text || '');
}

export function resolveOutgoingMentions(text, registry = {}) {
  const names = Object.keys(registry).sort((a, b) => b.length - a.length);
  let resolved = text;
  let hasMentions = hasLarkAtTag(text);

  for (const name of names) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`@${escapedName}(?=\\s|$|[，。！？,.:;)]|\\n)`, 'g');
    if (pattern.test(resolved)) {
      const entry = registry[name];
      if (!entry?.open_id) continue;
      hasMentions = true;
      resolved = resolved.replace(pattern, `<at user_id="${entry.open_id}">${name}</at>`);
    }
  }

  return { resolved, hasMentions };
}
