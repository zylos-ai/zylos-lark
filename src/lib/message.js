/**
 * Lark Messaging Functions
 */

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import { getClient } from './client.js';
import { getCredentials, getProxyConfig } from './config.js';

/**
 * Get fresh access token for direct API calls
 */
async function getAccessToken() {
  const creds = getCredentials();
  const proxy = getProxyConfig();

  const res = await axios({
    method: 'POST',
    url: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    headers: { 'Content-Type': 'application/json' },
    data: { app_id: creds.app_id, app_secret: creds.app_secret },
    proxy
  });

  return res.data.tenant_access_token;
}

/**
 * Send message to a chat (group or individual)
 */
export async function sendMessage(receiveId, content, receiveIdType = 'chat_id', msgType = 'text') {
  const client = getClient();

  let messageContent;
  if (msgType === 'text') {
    messageContent = JSON.stringify({ text: content });
  } else {
    messageContent = typeof content === 'string' ? content : JSON.stringify(content);
  }

  try {
    const res = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: msgType,
        content: messageContent,
      },
    });

    if (res.code === 0) {
      return {
        success: true,
        messageId: res.data.message_id,
        message: 'Message sent successfully',
      };
    } else {
      return {
        success: false,
        message: `Failed to send: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Send message to a group chat
 */
export async function sendToGroup(chatId, content, msgType = 'text') {
  return sendMessage(chatId, content, 'chat_id', msgType);
}

/**
 * Send message to a user
 */
export async function sendToUser(userId, content, msgType = 'text') {
  const idType = userId.startsWith('ou_') ? 'open_id' : 'user_id';
  return sendMessage(userId, content, idType, msgType);
}

/**
 * List messages in a chat
 */
export async function listMessages(chatId, limit = 20, sortType = 'desc', startTime = null, endTime = null) {
  const client = getClient();

  try {
    const params = {
      container_id_type: 'chat',
      container_id: chatId,
      page_size: Math.min(limit, 50),
      sort_type: sortType === 'asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc',
    };

    if (startTime) params.start_time = String(startTime);
    if (endTime) params.end_time = String(endTime);

    const res = await client.im.message.list({ params });

    if (res.code === 0) {
      const messages = (res.data.items || []).map(msg => ({
        id: msg.message_id,
        type: msg.msg_type,
        content: parseMessageContent(msg.body?.content, msg.msg_type),
        sender: msg.sender?.id,
        createTime: new Date(parseInt(msg.create_time)).toISOString(),
      }));

      return { success: true, messages, hasMore: res.data.has_more };
    } else {
      return { success: false, message: `Failed to list messages: ${res.msg}`, code: res.code };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function parseMessageContent(content, msgType) {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content);
    if (msgType === 'text') return parsed.text || '';
    return content;
  } catch {
    return content;
  }
}

/**
 * Download image from Lark message
 */
export async function downloadImage(messageId, imageKey, savePath) {
  try {
    const token = await getAccessToken();
    const proxy = getProxyConfig();

    const res = await axios({
      method: 'GET',
      url: `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`,
      headers: { 'Authorization': 'Bearer ' + token },
      responseType: 'arraybuffer',
      proxy
    });

    if (res.data && res.data.length > 0) {
      fs.writeFileSync(savePath, res.data);
      return { success: true, path: savePath, message: 'Image downloaded successfully' };
    } else {
      return { success: false, message: 'No data in response' };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Upload image to Lark
 */
export async function uploadImage(imagePath, imageType = 'message') {
  try {
    const token = await getAccessToken();
    const proxy = getProxyConfig();

    const form = new FormData();
    form.append('image_type', imageType);
    form.append('image', fs.createReadStream(imagePath));

    const res = await axios({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/im/v1/images',
      headers: {
        'Authorization': 'Bearer ' + token,
        ...form.getHeaders()
      },
      data: form,
      proxy
    });

    if (res.data.code === 0) {
      return { success: true, imageKey: res.data.data.image_key, message: 'Image uploaded successfully' };
    } else {
      return { success: false, message: `Failed to upload image: ${res.data.msg}`, code: res.data.code };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Send image message
 */
export async function sendImage(receiveId, imageKey, receiveIdType = 'chat_id') {
  const client = getClient();

  try {
    const res = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      },
    });

    if (res.code === 0) {
      return { success: true, messageId: res.data.message_id, message: 'Image sent successfully' };
    } else {
      return { success: false, message: `Failed to send image: ${res.msg}`, code: res.code };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Download file from Lark message
 */
export async function downloadFile(messageId, fileKey, savePath) {
  try {
    const token = await getAccessToken();
    const proxy = getProxyConfig();

    const res = await axios({
      method: 'GET',
      url: `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`,
      headers: { 'Authorization': 'Bearer ' + token },
      responseType: 'arraybuffer',
      proxy
    });

    if (res.data && res.data.length > 0) {
      fs.writeFileSync(savePath, res.data);
      return { success: true, path: savePath, message: 'File downloaded successfully' };
    } else {
      return { success: false, message: 'No data in response' };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Upload file to Lark
 */
export async function uploadFile(filePath, fileType = 'stream') {
  const client = getClient();

  try {
    const fileData = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    const res = await client.im.file.create({
      data: {
        file_type: fileType,
        file_name: fileName,
        file: fileData,
      },
    });

    if (res.code === 0) {
      return { success: true, fileKey: res.data.file_key, message: 'File uploaded successfully' };
    } else {
      return { success: false, message: `Failed to upload file: ${res.msg}`, code: res.code };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Send file message
 */
export async function sendFile(receiveId, fileKey, receiveIdType = 'chat_id') {
  const client = getClient();

  try {
    const res = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
    });

    if (res.code === 0) {
      return { success: true, messageId: res.data.message_id, message: 'File sent successfully' };
    } else {
      return { success: false, message: `Failed to send file: ${res.msg}`, code: res.code };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}
