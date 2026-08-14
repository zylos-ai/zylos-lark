/**
 * Composition helpers for the manual `lark-cli` (this component's CLI) media
 * commands.
 *
 * These route send/download through the system `lark-cli` (via the bridge
 * helpers) with the existing direct Lark API as the fallback ("fallback A"),
 * exactly like scripts/send.js and scripts/download.js. Kept in their own
 * module so the CLI behavior is unit-testable with the runLarkCli seam
 * injected. All collaborators are injectable via `deps`.
 */

import { sendMedia as larkSendMedia, downloadResource as larkDownloadResource } from './lark-cli-bridge.js';
import { directSendMedia } from './media-send.js';
import { downloadImage as directDownloadImage, downloadFile as directDownloadFile } from './message.js';

/**
 * Upload+send an image/file to a chat: prefer lark-cli, fall back to direct API.
 *
 * @param {object} args
 * @param {string} args.chatId
 * @param {'image'|'file'} args.type
 * @param {string} args.path
 * @param {object} [deps]  injectable: larkSend, directSend, run (runLarkCli seam)
 * @returns {Promise<object>} normalized result (throws only if both paths hard-fail)
 */
export async function cliSendMedia({ chatId, type, path: filePath }, deps = {}) {
  const {
    larkSend = larkSendMedia,
    directSend = directSendMedia,
    run,
  } = deps;
  return larkSend(
    { chatId, kind: type, path: filePath },
    () => directSend({ chatId, type, path: filePath }),
    run ? { run } : undefined,
  );
}

/**
 * Download an image/file resource: prefer lark-cli, fall back to direct API.
 *
 * @param {object} args
 * @param {string} args.messageId
 * @param {string} args.fileKey
 * @param {'image'|'file'} args.type
 * @param {string} args.outPath
 * @param {object} [deps]  injectable: larkDownload, downloadImage, downloadFile, run
 * @returns {Promise<{ success: boolean, path?: string, message?: string }>}
 */
export async function cliDownloadMedia({ messageId, fileKey, type, outPath }, deps = {}) {
  const {
    larkDownload = larkDownloadResource,
    downloadImage = directDownloadImage,
    downloadFile = directDownloadFile,
    run,
  } = deps;
  const fallback = () => (type === 'image'
    ? downloadImage(messageId, fileKey, outPath)
    : downloadFile(messageId, fileKey, outPath));
  return larkDownload({ messageId, fileKey, type, outPath }, fallback, run ? { run } : undefined);
}
