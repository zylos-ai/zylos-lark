/**
 * WebSocket long connection transport for Lark/Feishu
 *
 * Uses SDK's WSClient with EventDispatcher for persistent event subscription.
 *
 * Connection state tracking:
 * Uses a custom logger (public WSClient API) to intercept SDK log messages
 * and detect connect/disconnect events. This avoids accessing private SDK internals.
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
  reconnectCount: 0,
};

/**
 * Create a custom logger that intercepts SDK log messages to track connection state.
 * The logger parameter is a public WSClient API — no private internals accessed.
 *
 * SDK log patterns (from source):
 * - info  '[ws]' 'ws client ready'     → connection established
 * - debug '[ws]' 'ws connect success'  → WebSocket open
 * - info  '[ws]' 'reconnect'           → reconnection attempt
 * - debug '[ws]' 'client closed'       → WebSocket closed
 * - error '[ws]' 'connect failed'      → initial connection failed
 * - error '[ws]' 'ws connect failed'   → WebSocket error on connect
 */
function createConnectionLogger() {
  const update = (connected) => {
    if (connected && !connectionState.connected) {
      connectionState.connected = true;
      connectionState.connectedSince = new Date().toISOString();
      console.log('[lark] WS connected');
    } else if (!connected && connectionState.connected) {
      connectionState.connected = false;
      connectionState.connectedSince = null;
      console.log('[lark] WS disconnected');
    }
  };

  return {
    info: (...args) => {
      const msg = args[1] || '';
      if (typeof msg === 'string') {
        if (msg.includes('ws client ready')) {
          update(true);
        } else if (msg.includes('reconnect') && !msg.includes('success')) {
          connectionState.reconnectCount++;
          update(false);
        }
      }
      console.log(...args);
    },
    debug: (...args) => {
      const msg = args[1] || '';
      if (typeof msg === 'string') {
        if (msg.includes('ws connect success')) {
          update(true);
        } else if (msg.includes('client closed')) {
          update(false);
        }
      }
      // SDK debug logs are verbose — don't forward to console
    },
    error: (...args) => {
      const msg = args[1] || '';
      if (typeof msg === 'string') {
        if (msg.includes('connect failed') || msg.includes('ws connect failed')) {
          update(false);
        }
      }
      console.error(...args);
    },
    warn: (...args) => { console.warn(...args); },
    trace: () => {},  // suppress trace-level noise
  };
}

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
    logger: createConnectionLogger(),
    autoReconnect: true,
  });

  wsClient.start({ eventDispatcher });
  console.log('[lark] WebSocket client starting...');
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
  connectionState.connectedSince = null;
  console.log('[lark] WebSocket client stopped');
}

/**
 * Get current connection state for /health endpoint.
 */
export function getConnectionState() {
  return { ...connectionState };
}
