/**
 * Extract readable text and resource metadata from a Lark post (rich text)
 * message.
 *
 * File elements need explicit metadata just like images and videos. Without
 * it, a file-only post becomes an empty message and the receiving agent has no
 * indication that attachments exist or which resource keys to download.
 *
 * @param {object|Array} postContent Parsed Lark post body. An array is accepted
 *   for compatibility with older callers that passed only `content`.
 * @param {string} messageId Lark message ID used for resource downloads.
 * @returns {{ text: string, imageKeys: string[] }}
 */
export function extractPostText(postContent, messageId) {
  const post = Array.isArray(postContent) ? { content: postContent } : (postContent || {});
  const paragraphs = Array.isArray(post.content)
    ? post.content
    : (Array.isArray(post.content_v2) ? post.content_v2 : []);
  const imageKeys = [];
  const lines = [];
  const seenFiles = new Set();

  const fileMetadata = (file) => {
    const fileName = file?.file_name || 'unknown';
    const fileKey = file?.file_key || 'unknown';
    seenFiles.add(`${fileKey}\0${fileName}`);
    return `[file: ${fileName}, file_key: ${fileKey}, msg_id: ${messageId}]`;
  };

  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue;
    const parts = [];

    for (const el of paragraph) {
      switch (el.tag) {
        case 'text':
          parts.push(el.text || '');
          break;
        case 'at':
          parts.push(`@${el.user_name || el.user_id || 'unknown'}`);
          break;
        case 'a':
          if (el.href) {
            parts.push(`${el.text || ''}(${el.href})`);
          } else {
            parts.push(el.text || '');
          }
          break;
        case 'img':
          if (el.image_key) {
            imageKeys.push(el.image_key);
            parts.push(`[image, image_key: ${el.image_key}, msg_id: ${messageId}]`);
          }
          break;
        case 'file':
          parts.push(fileMetadata(el));
          break;
        case 'media':
          parts.push(`[media, file_key: ${el.file_key || 'unknown'}, msg_id: ${messageId}]`);
          break;
        case 'emotion':
          parts.push(el.emoji_type ? `[${el.emoji_type}]` : '');
          break;
        default:
          if (el.text) parts.push(el.text);
          break;
      }
    }

    lines.push(parts.join(''));
  }

  // Lark represents attachments added through the rich-post composer in a
  // top-level `files[]` array, separate from the paragraph `content`. A post
  // may therefore have `content: [[]]` while still containing several files.
  while (lines.length > 0 && !lines.at(-1)) lines.pop();
  for (const file of (Array.isArray(post.files) ? post.files : [])) {
    const identity = `${file?.file_key || 'unknown'}\0${file?.file_name || 'unknown'}`;
    if (!seenFiles.has(identity)) lines.push(fileMetadata(file));
  }

  return { text: lines.join('\n'), imageKeys };
}
