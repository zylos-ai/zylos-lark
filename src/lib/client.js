/**
 * Lark SDK Client
 * Handles authentication and provides client instance
 *
 * Credentials from environment variables:
 * - LARK_APP_ID
 * - LARK_APP_SECRET
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { getCredentials } from './config.js';

let clientInstance = null;

/**
 * Create and return Lark client instance
 */
export function getClient() {
  if (clientInstance) {
    return clientInstance;
  }

  const creds = getCredentials();

  if (!creds.app_id || !creds.app_secret) {
    throw new Error('LARK_APP_ID and LARK_APP_SECRET must be set in ~/zylos/.env');
  }

  clientInstance = new lark.Client({
    appId: creds.app_id,
    appSecret: creds.app_secret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,  // Chinese version (feishu.cn)
  });

  return clientInstance;
}

/**
 * Reset client instance (useful for config changes)
 */
export function resetClient() {
  clientInstance = null;
}

/**
 * Test authentication by getting tenant access token
 */
export async function testAuth() {
  const client = getClient();

  try {
    // Try to list chats as a simple auth test
    const res = await client.im.chat.list({
      params: {
        page_size: 1
      }
    });

    if (res.code === 0) {
      return { success: true, message: 'Authentication successful' };
    } else {
      return { success: false, message: `API error: ${res.msg}`, code: res.code };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}
