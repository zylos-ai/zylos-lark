import test from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import { AxiosError } from 'axios';

import { safeError, formatSafeError, sanitizeLogArg, createSafeSdkLogger } from '../src/lib/safe-error.js';

const SECRET = 'TEST_SECRET_VALUE';
const AUTH = 'Bearer TEST_AUTH_HEADER_VALUE';

// Shape of the 2026-10 incident: token request fails on TLS handshake and the
// whole axios error (config.data with app_secret, headers) was logged.
function makeAxiosError() {
  const config = {
    method: 'post',
    url: 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal?debug=1',
    headers: { 'Content-Type': 'application/json', Authorization: AUTH },
    data: JSON.stringify({ app_id: 'cli_test', app_secret: SECRET }),
  };
  const err = new AxiosError('write EPROTO SSL routines:ssl3_read_bytes', 'EPROTO', config, { path: '/x', _header: `Authorization: ${AUTH}` });
  err.response = { status: 502, data: { code: 99991663, msg: 'bad gateway' }, config };
  return err;
}

function render(value) {
  return typeof value === 'string' ? value : util.inspect(value, { depth: 10 });
}

function assertClean(text) {
  assert.ok(!text.includes(SECRET), 'output must not contain app_secret value');
  assert.ok(!text.includes('TEST_AUTH_HEADER_VALUE'), 'output must not contain Authorization header');
  assert.ok(!text.includes('app_secret'), 'output must not contain app_secret key');
}

test('safeError keeps only safe fields of an axios error', () => {
  const out = safeError(makeAxiosError());
  assertClean(render(out));
  assert.deepEqual(out, {
    code: 'EPROTO',
    message: 'write EPROTO SSL routines:ssl3_read_bytes',
    status: 502,
    apiCode: 99991663,
    apiMsg: 'bad gateway',
    method: 'POST',
    path: '/open-apis/auth/v3/tenant_access_token/internal',
  });
});

test('formatSafeError string has no secret, header or query string', () => {
  const s = formatSafeError(makeAxiosError());
  assertClean(s);
  assert.ok(!s.includes('debug=1'));
  assert.match(s, /EPROTO/);
  assert.match(s, /POST \/open-apis\/auth\/v3\/tenant_access_token\/internal/);
});

test('sanitizeLogArg redacts sensitive keys in plain objects', () => {
  const s = sanitizeLogArg({ app_id: 'cli_test', app_secret: SECRET, headers: { Authorization: AUTH } });
  assertClean(s.replace('"app_secret":"[REDACTED]"', ''));
  assert.match(s, /\[REDACTED\]/);
});

test('SDK logger never prints the raw axios error', () => {
  const lines = [];
  const sink = Object.fromEntries(['error', 'warn', 'info', 'debug'].map((k) => [k, (...a) => lines.push(a.map(render).join(' '))]));
  const logger = createSafeSdkLogger(sink);
  const err = makeAxiosError();
  // SDK LoggerProxy passes args as a single array
  logger.error([err]);
  logger.error([[{ message: err.message, config: { data: err.config.data, url: err.config.url, method: 'post' } }]]);
  logger.info(['[ws]', 'ws client ready']);
  assert.equal(lines.length, 3);
  for (const line of lines) assertClean(line);
  assert.match(lines[0], /^\[error\]: .*EPROTO/);
  assert.equal(lines[2], '[info]: [ws] ws client ready');
});
