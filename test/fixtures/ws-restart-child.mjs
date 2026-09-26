/**
 * Child process for test/ws-restart-process.test.js (NOT a test file itself;
 * the npm test script only runs test/*.test.js).
 *
 * Runs the production websocket transport with the REAL SDK WSClient against
 * the loopback fake Lark server, using the default exit path (process.exit).
 * Emits one JSON object per stdout line so the parent (acting as PM2) can
 * observe it. Env: FAKE_LARK_DOMAIN, WS_STATE_FILE, WS_TICK_MS.
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { createWebSocketTransport } from '../../src/lib/transport/websocket.js';
import { makeHttpInstance } from './fake-lark-server.mjs';

const emit = (obj) => process.stdout.write(`${JSON.stringify({ pid: process.pid, ...obj })}\n`);

let constructed = 0;
let dataCacheInterval = null;

class ChildWSClient extends lark.WSClient {
  constructor(params) {
    // Capture the DataCache setInterval handle the SDK creates in its
    // constructor (it keeps no reference to it itself).
    const origSetInterval = globalThis.setInterval;
    globalThis.setInterval = (...args) => (dataCacheInterval = origSetInterval(...args));
    try {
      super({
        ...params,
        domain: process.env.FAKE_LARK_DOMAIN,
        httpInstance: makeHttpInstance(),
        loggerLevel: lark.LoggerLevel.error,
      });
    } finally {
      globalThis.setInterval = origSetInterval;
    }
    constructed++;
    emit({ ev: 'wsclient-constructed', n: constructed });
  }
}

const log = {
  log: (m) => emit({ ev: 'log', level: 'info', m }),
  warn: (m) => emit({ ev: 'log', level: 'warn', m }),
  error: (m) => emit({ ev: 'log', level: 'error', m }),
};

const tr = createWebSocketTransport({
  WSClient: ChildWSClient,
  log,
  stateFile: process.env.WS_STATE_FILE,
  watchdogTickMs: Number(process.env.WS_TICK_MS || 100),
});

await tr.start({ domain: 'lark' }, { app_id: 'cli_test', app_secret: 'test-secret' }, async () => {}, () => false, {
  onShutdown: async ({ reason }) => {
    emit({
      ev: 'on-shutdown',
      reason,
      constructed,
      clientAfterClose: tr._getClient() === null,
      // SDK close() never clears this interval; only process exit does.
      dataCacheIntervalAlive: !!dataCacheInterval && dataCacheInterval.hasRef() && !dataCacheInterval._destroyed,
    });
  },
});
emit({ ev: 'started', state: tr.getConnectionState() });

process.on('SIGTERM', () => {
  tr.stop();
  process.exit(0);
});
