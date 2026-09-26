/**
 * Loopback stand-in for the Lark long-connection backend, used to drive the
 * REAL @larksuiteoapi/node-sdk WSClient without any external network:
 * - POST /callback/ws/endpoint  -> config pull (what WSClient.pullConnectConfig calls)
 * - ws://127.0.0.1:<port>/ws    -> the event socket; replies to every client
 *   ping with a protobuf pong frame while `respond` is true. Setting
 *   respond=false makes the socket half-open from the client's view: it stays
 *   OPEN, no close/error, no inbound frames.
 * Every config request (on arrival) / socket connection / ping / close is
 * recorded in `events` so tests can assert nothing new happens after a restart request.
 */
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Use the SDK's own `ws` dependency (same version the client uses).
const { WebSocketServer } = createRequire(require.resolve('@larksuiteoapi/node-sdk'))('ws');

// ---- minimal protobuf encoder for pbbp2.Frame (field numbers from SDK 1.59.0) ----
function varint(n) {
  const out = [];
  let v = n >>> 0;
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v);
  return Buffer.from(out);
}
const tag = (no, wt) => varint((no << 3) | wt);
const vField = (no, n) => Buffer.concat([tag(no, 0), varint(n)]);
const lField = (no, buf) => Buffer.concat([tag(no, 2), varint(buf.length), buf]);

export function encodeFrame({ service = 1, method = 0, headers = [], payload }) {
  const parts = [vField(1, 0), vField(2, 0), vField(3, service), vField(4, method)];
  for (const h of headers) {
    parts.push(lField(5, Buffer.concat([lField(1, Buffer.from(h.key)), lField(2, Buffer.from(h.value))])));
  }
  if (payload) parts.push(lField(8, Buffer.from(payload)));
  return Buffer.concat(parts);
}

export async function startFakeLark({ pingIntervalSec = 1 } = {}) {
  const events = [];
  let respond = true;
  let configDelayMs = 0;
  let port = 0;
  const clientConfig = { PingInterval: pingIntervalSec, ReconnectCount: -1, ReconnectInterval: 1, ReconnectNonce: 0 };
  const record = (type, extra = {}) => events.push({ type, t: Date.now(), ...extra });

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/callback/ws/endpoint') {
      req.resume();
      req.on('end', () => { record('config'); setTimeout(() => {
        record('config-answered');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          code: 0,
          msg: 'ok',
          data: { URL: `ws://127.0.0.1:${port}/ws?device_id=dev1&service_id=1`, ClientConfig: clientConfig },
        }));
      }, configDelayMs); });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  const sockets = new Set();
  wss.on('connection', (sock) => {
    sockets.add(sock);
    record('connect');
    sock.on('message', () => {
      record('ping');
      if (!respond) return;
      sock.send(encodeFrame({
        method: 0,
        headers: [{ key: 'type', value: 'pong' }],
        payload: JSON.stringify(clientConfig),
      }));
      record('pong');
    });
    sock.on('close', () => { sockets.delete(sock); record('close'); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;

  return {
    port,
    domain: `http://127.0.0.1:${port}`,
    events,
    setRespond(v) { respond = v; },
    /** Delay config-pull responses (to hold a reConnect closure in flight). */
    setConfigDelay(ms) { configDelayMs = ms; },
    /** Server-side close of every open socket (triggers the SDK's own reConnect). */
    dropSockets() { for (const s of sockets) s.close(); },
    count(type, sinceT = 0) { return events.filter((e) => e.type === type && e.t >= sinceT).length; },
    async close() {
      for (const s of sockets) s.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * httpInstance for WSClient: forwards the config pull to the loopback server
 * with node:http (no axios, no proxy env involvement) and returns the JSON
 * body, matching what the SDK's default axios instance resolves to.
 */
export function makeHttpInstance() {
  return {
    request({ method = 'post', url, data }) {
      return new Promise((resolve, reject) => {
        const body = JSON.stringify(data || {});
        const req = http.request(url, { method: method.toUpperCase(), headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { buf += c; });
          res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.end(body);
      });
    },
  };
}
