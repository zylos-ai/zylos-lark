import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import * as lark from '@larksuiteoapi/node-sdk';
import { AxiosError, AxiosHeaders } from 'axios';

// Isolate from the real ~/zylos config: config.js reads HOME at import time.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-redact-test-'));
process.env.HOME = tmpHome;
test.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

// Fake values only.
const FAKE_SECRET = 'fakeSecretValue0123456789ABCDEF';
const FAKE_TENANT_TOKEN = 't-fakeTenantToken0123456789abcdef';
const FAKE_USER_TOKEN = 'u-fakeUserToken0123456789abcdefgh';
const FAKE_ENCRYPT_KEY = 'fakeEncryptKey0123456789';
const FAKE_VERIFY_TOKEN = 'fakeVerifyToken0123456789';
const TOKEN_URL = 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal';

process.env.LARK_APP_ID = 'cli_fakeappid0001';
process.env.LARK_APP_SECRET = FAKE_SECRET;

const {
  redact, redactText, isSensitiveKey, createRedactingLogger, installConsoleRedaction,
  registerSecrets, clearRegisteredSecrets, REDACTED,
} = await import('../src/lib/redact.js');
const { getClient, resetClient } = await import('../src/lib/client.js');

const ALL_FAKES = [FAKE_SECRET, FAKE_TENANT_TOKEN, FAKE_USER_TOKEN, FAKE_ENCRYPT_KEY, FAKE_VERIFY_TOKEN];

function assertNoSecrets(text) {
  for (const s of ALL_FAKES) assert.ok(!text.includes(s), `leaked ${s.slice(0, 6)}... in:\n${text}`);
}

/** The shape observed in the live log: tenant-token POST failing with ECONNREFUSED. */
function makeTokenAxiosError({ response } = {}) {
  const config = {
    method: 'post',
    url: TOKEN_URL,
    headers: new AxiosHeaders({ 'Content-Type': 'application/json', Authorization: `Bearer ${FAKE_USER_TOKEN}` }),
    data: JSON.stringify({ app_id: 'cli_fakeappid0001', app_secret: FAKE_SECRET }),
    timeout: 0,
  };
  const request = {
    _currentUrl: TOKEN_URL,
    _requestBodyBuffers: [{ data: Buffer.from(config.data) }],
    _options: { headers: { authorization: `Bearer ${FAKE_TENANT_TOKEN}` } },
  };
  const err = new AxiosError('connect ECONNREFUSED 127.0.0.1:443', 'ECONNREFUSED', config, request, response);
  const cause = new Error('connect ECONNREFUSED 127.0.0.1:443');
  Object.assign(cause, { errno: -111, code: 'ECONNREFUSED', syscall: 'connect', address: '127.0.0.1', port: 443 });
  err.cause = cause;
  return err;
}

test.beforeEach(() => {
  clearRegisteredSecrets();
});

test('isSensitiveKey matches secret/token/header keys in any casing', () => {
  for (const k of ['app_secret', 'appSecret', 'tenant_access_token', 'user_access_token', 'access_token',
    'refresh_token', 'Authorization', 'authorization', 'Proxy-Authorization', 'encrypt_key', 'encryptKey',
    'verification_token', 'verificationToken', 'token', 'Cookie', 'x-internal-token', 'client_secret']) {
    assert.ok(isSensitiveKey(k), k);
  }
  for (const k of ['app_id', 'url', 'method', 'code', 'msg', 'message', 'status', 'chat_id', 'page_token_x']) {
    assert.ok(!isSensitiveKey(k), k);
  }
});

test('redactText masks JSON bodies, inspected objects, query strings and Bearer tokens', () => {
  const body = JSON.stringify({ app_id: 'cli_fakeappid0001', app_secret: FAKE_SECRET });
  assert.equal(redactText(body), `{"app_id":"cli_fakeappid0001","app_secret":"${REDACTED}"}`);

  // JSON embedded inside a JSON string (escaped quotes)
  const nested = JSON.stringify({ data: body });
  const out = redactText(nested);
  assertNoSecrets(out);
  assert.ok(out.includes('cli_fakeappid0001'));

  assert.equal(redactText(`{ tenant_access_token: '${FAKE_TENANT_TOKEN}', expire: 7200 }`),
    `{ tenant_access_token: '${REDACTED}', expire: 7200 }`);
  assert.equal(redactText(`wss://x.example/ws?device_id=1&access_key=abc123&ticket=tk-9`),
    `wss://x.example/ws?device_id=1&access_key=${REDACTED}&ticket=${REDACTED}`);
  assert.equal(redactText(`Authorization: Bearer ${FAKE_USER_TOKEN}`), `Authorization: Bearer ${REDACTED}`);
  assert.equal(redactText(`token is ${FAKE_TENANT_TOKEN} now`), `token is ${REDACTED} now`);
  assert.equal(redactText(`"encrypt_key": "${FAKE_ENCRYPT_KEY}", "verification_token":"${FAKE_VERIFY_TOKEN}"`),
    `"encrypt_key": "${REDACTED}", "verification_token":"${REDACTED}"`);
});

test('redactText is idempotent and leaves ordinary log lines untouched', () => {
  const once = redactText(`{"app_secret":"${FAKE_SECRET}"} token=${FAKE_TENANT_TOKEN} Bearer ${FAKE_USER_TOKEN}`);
  assert.equal(redactText(once), once);
  for (const line of [
    '[lark] Bot @mentioned in group oc_abc123',
    '[lark] WebSocket client started (pong timeout: 3 x ping interval)',
    'connect ECONNREFUSED 127.0.0.1:443',
    '[lark] verification_token not configured — rejecting request.',
    `url: '${TOKEN_URL}'`,
  ]) {
    assert.equal(redactText(line), line);
  }
});

test('registered literal secrets are removed even without a recognisable key', () => {
  registerSecrets(FAKE_SECRET, 'short', '', undefined);
  assert.equal(redactText(`oops ${FAKE_SECRET} leaked`), `oops ${REDACTED} leaked`);
  assert.equal(redactText('a short word'), 'a short word', 'values under 8 chars are not registered');
});

test('redact() turns the tenant-token AxiosError into a useful, secret-free error', () => {
  const err = makeTokenAxiosError();
  const out = redact(err);
  assert.ok(out instanceof Error);
  assert.equal(out.name, 'AxiosError');
  assert.equal(out.message, 'connect ECONNREFUSED 127.0.0.1:443');
  assert.equal(out.code, 'ECONNREFUSED');
  assert.equal(out.method, 'POST');
  assert.equal(out.url, TOKEN_URL);
  assert.equal(out.cause.code, 'ECONNREFUSED');
  assert.equal(out.config, undefined, 'raw axios config is dropped');
  assert.equal(out.request, undefined, 'raw request is dropped');
  const printed = util.inspect(out, { depth: 10 });
  assertNoSecrets(printed);
  assert.ok(printed.includes(TOKEN_URL));
  // input not mutated
  assert.ok(err.config.data.includes(FAKE_SECRET));
});

test('redact() keeps status and redacted response data of an HTTP error', () => {
  const err = makeTokenAxiosError({
    response: { status: 400, data: { code: 99991663, msg: 'invalid', tenant_access_token: FAKE_TENANT_TOKEN } },
  });
  const out = redact(err);
  assert.equal(out.status, 400);
  assert.equal(out.responseData.code, 99991663);
  assert.equal(out.responseData.tenant_access_token, REDACTED);
});

test('redact() masks nested keys, header objects, arrays, buffers and handles cycles', () => {
  const obj = {
    config: {
      url: TOKEN_URL,
      headers: new AxiosHeaders({ Authorization: `Bearer ${FAKE_TENANT_TOKEN}` }),
      data: JSON.stringify({ app_secret: FAKE_SECRET }),
    },
    list: [{ user_access_token: FAKE_USER_TOKEN }, `Bearer ${FAKE_USER_TOKEN}`],
    bot: { encrypt_key: FAKE_ENCRYPT_KEY, verification_token: FAKE_VERIFY_TOKEN, app_id: 'cli_x' },
    body: Buffer.from(JSON.stringify({ app_secret: FAKE_SECRET })),
    nested: new Map([['appSecret', FAKE_SECRET]]),
  };
  obj.self = obj;
  const out = redact(obj);
  assert.equal(out.self, '[Circular]');
  assert.equal(out.config.url, TOKEN_URL);
  assert.equal(out.bot.app_id, 'cli_x');
  assert.equal(out.bot.encrypt_key, REDACTED);
  assert.equal(out.list[0].user_access_token, REDACTED);
  assertNoSecrets(util.inspect(out, { depth: 10 }));
});

test('redact() keeps SDK-style error arrays readable', () => {
  const out = redact([[{ message: 'Request failed with status code 400' }, { code: 41050, msg: 'no user authority error' }]]);
  assert.deepEqual(out, [[{ message: 'Request failed with status code 400' }, { code: 41050, msg: 'no user authority error' }]]);
});

function captureOut() {
  const lines = [];
  const rec = (stream) => (...args) => lines.push({ stream, text: util.format(...args) });
  return { lines, out: { log: rec('log'), warn: rec('warn'), info: rec('info'), debug: rec('debug'), trace: rec('trace') } };
}

test('createRedactingLogger keeps the SDK default format/streams and redacts arguments', () => {
  const { lines, out } = captureOut();
  const logger = createRedactingLogger(out);
  logger.error([makeTokenAxiosError()]);
  logger.info(['[ws]', `ws url: wss://x.example/ws?access_key=abc123&ticket=${FAKE_TENANT_TOKEN}`]);
  logger.warn('plain');
  assert.equal(lines[0].stream, 'log');
  assert.ok(lines[0].text.startsWith('[error]: '));
  assert.ok(lines[0].text.includes('ECONNREFUSED'));
  assert.ok(lines[0].text.includes(TOKEN_URL));
  assert.equal(lines[1].stream, 'info');
  assert.equal(lines[2].text, '[warn]: plain');
  for (const l of lines) assertNoSecrets(l.text);
});

test('the SDK Client uses the redacting logger: a failed tenant-token fetch logs no secret', async (t) => {
  const { lines, out } = captureOut();
  // Route the redacting logger created inside getClient() to our capture.
  const saved = { log: console.log, warn: console.warn, info: console.info, debug: console.debug, trace: console.trace };
  Object.assign(console, out);
  try {
    resetClient();
    const client = getClient();
    // Fail the token request the way a network error does.
    t.mock.method(client.tokenManager.httpInstance, 'post', async () => { throw makeTokenAxiosError(); });
    t.mock.method(client.httpInstance, 'request', async () => ({ code: 0 }));
    await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' }).catch(() => {});
  } finally {
    Object.assign(console, saved);
    resetClient();
  }
  const text = lines.map(l => l.text).join('\n');
  assert.ok(text.includes('[error]:'), `SDK logged nothing:\n${text}`);
  assert.ok(text.includes('ECONNREFUSED'));
  assertNoSecrets(text);
});

test('the SDK default logger would have leaked (guards the test above)', () => {
  const printed = util.inspect([makeTokenAxiosError()], { depth: 4 });
  assert.ok(printed.includes(FAKE_SECRET));
  assert.ok(lark.Client, 'SDK loaded');
});

test('installConsoleRedaction wraps console methods, is idempotent and restorable', () => {
  const { lines, out } = captureOut();
  const target = { ...out, error: (...a) => lines.push({ stream: 'error', text: util.format(...a) }) };
  const restore = installConsoleRedaction(target);
  assert.equal(installConsoleRedaction(target), restore, 'second install is a no-op');
  target.error('[lark] failed:', makeTokenAxiosError());
  target.log(`[lark] body {"app_secret":"${FAKE_SECRET}"}`);
  target.warn({ headers: { Authorization: `Bearer ${FAKE_USER_TOKEN}` } });
  assert.equal(lines.length, 3);
  for (const l of lines) assertNoSecrets(l.text);
  assert.ok(lines[0].text.includes('ECONNREFUSED'));
  restore();
  target.log(`raw ${FAKE_SECRET}`);
  assert.ok(lines[3].text.includes(FAKE_SECRET), 'restored to original');
});
