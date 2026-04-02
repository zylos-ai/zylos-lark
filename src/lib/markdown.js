/**
 * Markdown detection helpers for outgoing Lark messages.
 *
 * The goal is to send plain text for simple messages and reserve
 * interactive cards for content that actually benefits from markdown
 * rendering.
 */

const MARKDOWN_PATTERNS = [
  /```/,
  /^#{1,6}\s+\S/m,
  /(^|\n)\s*>\s+\S/m,
  /\[([^\]\n]+)\]\(([^)\s]+(?:\s+"[^"]*")?)\)/,
  /(^|[^\w])\*\*[^*\n]+?\*\*(?=[^\w]|$)/,
  /(^|[^\w])__[^_\n]+?__(?=[^\w]|$)/,
  /(^|[\s(])\*[^*\s][^*\n]*?[^*\s]\*(?=$|[\s),.!?:;])/,
  /(^|[\s(])_[^_\s][^_\n]*?[^_\s]_(?=$|[\s),.!?:;])/,
  /(^|[^\w])~~[^~\n]+?~~(?=[^\w]|$)/,
  /(^|[^\w])`[^`\n]+`(?=[^\w]|$)/,
  /(^|\n)\s*[-*+]\s+\S/m,
  /(^|\n)\s*\d+\.\s+\S/m,
  /(^|\n)\s*\|.+\|\s*\n\s*\|[\s:-]+(?:\|[\s:-]+)+\|?\s*(\n|$)/m,
];

export function hasMarkdownContent(text) {
  if (typeof text !== 'string') return false;

  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return false;

  return MARKDOWN_PATTERNS.some((pattern) => pattern.test(normalized));
}
