/**
 * Tests for getSheetValues throwOnError in src/lib/document.js
 *
 * Uses Node built-in test runner (node:test).
 * Run: node --test test/document-get-sheet-values.test.js
 *
 * No network: the SDK client's request() is stubbed on the prototype, the same
 * seam test/client-bot-info.test.js uses. The HOME override runs before the
 * config module is imported, so the real ~/zylos config is never read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-sheet-values-test-'));
process.env.HOME = tmpHome;
process.env.LARK_APP_ID = 'cli_test';
process.env.LARK_APP_SECRET = 'secret_test';
test.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

const { getSheetValues, SHEET_RANGE_OUT_OF_BOUNDS_CODE, SHEET_VALUES_REQUEST_FAILED } =
  await import('../src/lib/document.js');
const { resetClient } = await import('../src/lib/client.js');

// ---------- helpers ----------

const TOKEN = 'shtcnTestToken';
const RANGE = 'SUOFkP!A1:D10';

/**
 * Stub the SDK client's request(). Resolves with `response` or rejects with
 * `failure`. Records every request it receives.
 */
function stubRequest(t, { response, failure } = {}) {
  resetClient();
  const calls = [];
  t.mock.method(lark.Client.prototype, 'request', async (opts) => {
    calls.push(opts);
    if (failure) throw failure;
    return response;
  });
  return calls;
}

// ---------- fixtures ----------

const OK_RESPONSE = {
  code: 0,
  msg: 'success',
  data: {
    valueRange: {
      range: RANGE,
      values: [['name', 'qty'], ['apple', '3']],
    },
  },
};

const API_ERROR_RESPONSE = {
  code: 1310213,
  msg: 'spreadsheet not found',
  data: {},
};

const RANGE_OUT_OF_BOUNDS_RESPONSE = {
  code: 900015206,
  msg: 'range exceeds the sheet boundary',
  data: {},
};

// ---------- default behavior ----------

test('default: success returns { success, range, values }', async (t) => {
  stubRequest(t, { response: OK_RESPONSE });

  const result = await getSheetValues(TOKEN, RANGE);

  assert.equal(result.success, true);
  assert.equal(result.range, RANGE);
  assert.deepEqual(result.values, [['name', 'qty'], ['apple', '3']]);
});

test('default: a non-zero interface code returns { success: false } and never throws', async (t) => {
  stubRequest(t, { response: API_ERROR_RESPONSE });

  const result = await getSheetValues(TOKEN, RANGE);

  assert.equal(result.success, false);
  assert.equal(result.code, 1310213);
  assert.match(result.message, /spreadsheet not found/);
});

test('default: a transport failure returns { success: false } and never throws', async (t) => {
  const boom = new Error('socket hang up');
  boom.code = 'ECONNRESET';
  stubRequest(t, { failure: boom });

  const result = await getSheetValues(TOKEN, RANGE);

  assert.equal(result.success, false);
  assert.equal(result.message, 'socket hang up');
  assert.equal(result.code, undefined, 'default shape must not grow a code field');
});

test('default: 900015206 keeps the historical failure shape', async (t) => {
  stubRequest(t, { response: RANGE_OUT_OF_BOUNDS_RESPONSE });

  const result = await getSheetValues(TOKEN, RANGE);

  assert.equal(result.success, false);
  assert.equal(result.code, SHEET_RANGE_OUT_OF_BOUNDS_CODE);
});

test('default: an empty options object behaves like no options', async (t) => {
  stubRequest(t, { response: API_ERROR_RESPONSE });

  const result = await getSheetValues(TOKEN, RANGE, {});

  assert.equal(result.success, false);
  assert.equal(result.code, 1310213);
});

// ---------- throwOnError ----------

test('throwOnError: a non-zero interface code throws and carries that code', async (t) => {
  stubRequest(t, { response: API_ERROR_RESPONSE });

  await assert.rejects(
    () => getSheetValues(TOKEN, RANGE, { throwOnError: true }),
    (err) => {
      assert.ok(err instanceof Error, 'must reject with an Error');
      assert.equal(err.code, 1310213, 'err.code must be the API code');
      assert.match(err.message, /spreadsheet not found/);
      return true;
    },
  );
});

test('throwOnError: a transport failure rethrows the original error with its code', async (t) => {
  const boom = new Error('getaddrinfo ENOTFOUND open.larksuite.com');
  boom.code = 'ENOTFOUND';
  stubRequest(t, { failure: boom });

  await assert.rejects(
    () => getSheetValues(TOKEN, RANGE, { throwOnError: true }),
    (err) => {
      assert.equal(err, boom, 'the original error object must propagate');
      assert.equal(err.code, 'ENOTFOUND', 'the original code must be preserved');
      return true;
    },
  );
});

test('throwOnError: a transport failure without a code gets a stable fallback code', async (t) => {
  stubRequest(t, { failure: new Error('timed out') });

  await assert.rejects(
    () => getSheetValues(TOKEN, RANGE, { throwOnError: true }),
    (err) => {
      assert.equal(err.message, 'timed out');
      assert.equal(err.code, SHEET_VALUES_REQUEST_FAILED);
      return true;
    },
  );
});

test('throwOnError: 900015206 resolves as an empty table tail instead of throwing', async (t) => {
  stubRequest(t, { response: RANGE_OUT_OF_BOUNDS_RESPONSE });

  const result = await getSheetValues(TOKEN, RANGE, { throwOnError: true });

  assert.equal(result.success, true, 'range out of bounds is not an error');
  assert.deepEqual(result.values, [], 'values must be an empty array');
});

test('throwOnError: 900015206 echoes the requested range when the response has none', async (t) => {
  stubRequest(t, { response: { code: SHEET_RANGE_OUT_OF_BOUNDS_CODE, msg: 'oob' } });

  const result = await getSheetValues(TOKEN, RANGE, { throwOnError: true });

  assert.equal(result.success, true);
  assert.equal(result.range, RANGE);
  assert.deepEqual(result.values, []);
});

test('throwOnError: success returns the same shape as the default', async (t) => {
  stubRequest(t, { response: OK_RESPONSE });

  const result = await getSheetValues(TOKEN, RANGE, { throwOnError: true });

  assert.equal(result.success, true);
  assert.equal(result.range, RANGE);
  assert.deepEqual(result.values, [['name', 'qty'], ['apple', '3']]);
});

test('throwOnError: 900015206 is the only tolerated code, other range errors throw', async (t) => {
  stubRequest(t, { response: { code: 1310214, msg: 'invalid range' } });

  await assert.rejects(
    () => getSheetValues(TOKEN, RANGE, { throwOnError: true }),
    (err) => {
      assert.equal(err.code, 1310214);
      return true;
    },
  );
});

// ---------- request shape ----------

test('request shape is unchanged: same URL and render options', async (t) => {
  const calls = stubRequest(t, { response: OK_RESPONSE });

  await getSheetValues(TOKEN, RANGE, { throwOnError: true });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(
    calls[0].url,
    `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(TOKEN)}/values/${encodeURIComponent(RANGE)}`,
  );
  assert.equal(calls[0].params.valueRenderOption, 'ToString');
  assert.equal(calls[0].params.dateTimeRenderOption, 'FormattedString');
});
