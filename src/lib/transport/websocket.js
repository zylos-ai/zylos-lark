/**
 * WebSocket long connection transport for Lark/Feishu
 *
 * Uses SDK's WSClient with EventDispatcher for persistent event subscription.
 *
 * SDK issue node-sdk#177 (timer leak in reConnect):
 * - reconnectCount is NOT a valid WSClient constructor param (server-controlled)
 * - Mitigation: rely on autoReconnect only, never call reConnect externally
 * - PM2 kill_timeout + max_restarts handles persistent failures
 */

import * as lark from '@larksuiteoapi/node-sdk';

const DOMAIN_MAP = {
  feishu: lark.Domain.Feishu,
  lark: lark.Domain.Lark,
};

let wsClient = null;
let connectionState = {
  connected: false,
  connectedSince: null,
};

/**
 * Start WebSocket transport.
 * @param {object} config - from getConfig()
 * @param {object} credentials - { app_id, app_secret }
 * @param {function} handleMessageEvent - the message handler from index.js
 * @param {function} isDuplicate - dedup check function from index.js
 */
export function startWebSocket(config, credentials, handleMessageEvent, isDuplicate) {
  const domain = DOMAIN_MAP[config.domain] || lark.Domain.Lark;

  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      // SDK EventDispatcher flattens header + event fields into data top level.
      // data.message, data.sender, data.create_time are all at top level.
      const messageId = data.message?.message_id;
      if (isDuplicate(messageId)) return;

      // Wrap into the same shape as webhook events so handleMessageEvent works unchanged
      const event = {
        event: { message: data.message, sender: data.sender },
        header: { create_time: data.create_time || null },
      };
      try {
        await handleMessageEvent(event);
      } catch (err) {
        console.error(`[lark] WS pipeline error: ${err.message}`);
      }
    },
  });

  wsClient = new lark.WSClient({
    appId: credentials.app_id,
    appSecret: credentials.app_secret,
    domain,
    loggerLevel: lark.LoggerLevel.info,
    autoReconnect: true,
  });

  wsClient.start({ eventDispatcher });
  connectionState.connected = true;
  connectionState.connectedSince = new Date().toISOString();
  console.log('[lark] WebSocket client started');
}

/**
 * Stop WebSocket transport. Call this during shutdown.
 */
export function stopWebSocket() {
  if (!wsClient) return;
  try {
    wsClient.close();
  } catch (err) {
    console.warn(`[lark] WS close error: ${err.message}`);
  }
  wsClient = null;
  connectionState.connected = false;
  console.log('[lark] WebSocket client stopped');
}

/**
 * Get current connection state for /health endpoint.
 */
export function getConnectionState() {
  return { ...connectionState };
}
