/**
 * Agent-visible text of the inbound C4 message format.
 *
 * SMART_MODE_HINT is the standard smart-mode hint for channel components
 * (zylos-component-template references/channel-standards.md 11.6, the same
 * SMART_MODE_HINT as template/src/lib/format.js). It is part of the spec:
 * change it only together with the template.
 */

export const SMART_MODE_HINT = "Decide whether to respond. Do NOT reply if: the message is unrelated to you, "
  + "just casual chat, or doesn't need your input. Only reply when: 1) someone asks a question you can help with, "
  + '2) the discussion is on a topic you can substantially help with, 3) someone clearly needs assistance. '
  + 'When uncertain, prefer NOT to reply. Reply with exactly [SKIP] to stay silent.';
