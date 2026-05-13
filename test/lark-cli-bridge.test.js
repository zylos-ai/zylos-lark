import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLarkCliError,
  LarkCliAuthRequiredError,
} from '../src/lib/lark-cli-bridge.js';

test('parseLarkCliError extracts error envelope from clean JSON', () => {
  const text = `{
  "ok": false,
  "identity": "bot",
  "error": {
    "type": "calendar_user_login_required",
    "message": "needs login",
    "hint": "lark-cli auth login --domain calendar"
  }
}`;
  const e = parseLarkCliError(text);
  assert.equal(e.type, 'calendar_user_login_required');
  assert.equal(e.hint, 'lark-cli auth login --domain calendar');
});

test('parseLarkCliError handles tip-prefixed output', () => {
  const text = `tip: run "lark-cli mail user_mailboxes profile" to confirm
{
  "ok": false,
  "identity": "bot",
  "error": {
    "type": "permission",
    "code": 99991672,
    "message": "App scope not enabled"
  }
}`;
  const e = parseLarkCliError(text);
  assert.equal(e.type, 'permission');
  assert.equal(e.code, 99991672);
});

test('parseLarkCliError returns null for empty, garbage, or non-envelope JSON', () => {
  assert.equal(parseLarkCliError(''), null);
  assert.equal(parseLarkCliError(null), null);
  assert.equal(parseLarkCliError('hello world'), null);
  // valid JSON but no `error` key — not a lark-cli failure envelope
  assert.equal(parseLarkCliError('{"ok":true,"data":{"x":1}}'), null);
  // malformed JSON
  assert.equal(parseLarkCliError('{"ok":false,"error":{'), null);
});

test('parseLarkCliError finds JSON when it is preceded by non-JSON lines', () => {
  // Real lark-cli output sometimes interleaves human-readable lines before JSON
  const text = `warning: deprecated flag --foo
notice: using default config
{
  "ok": false,
  "error": { "type": "something_wrong" }
}`;
  const e = parseLarkCliError(text);
  assert.equal(e.type, 'something_wrong');
});

test('LarkCliAuthRequiredError carries all context fields', () => {
  const errInfo = {
    type: 'calendar_user_login_required',
    message: 'm',
    hint: 'h',
  };
  const original = new Error('child_process exit 3');
  const e = new LarkCliAuthRequiredError('calendar', 'h', errInfo, original);

  assert.ok(e instanceof Error);
  assert.ok(e instanceof LarkCliAuthRequiredError);
  assert.equal(e.name, 'LarkCliAuthRequiredError');
  assert.equal(e.domain, 'calendar');
  assert.equal(e.hint, 'h');
  assert.equal(e.errorInfo, errInfo);
  assert.equal(e.originalError, original);
  assert.match(e.message, /calendar/);
});

test('LarkCliAuthRequiredError formats unknown domain gracefully', () => {
  const e = new LarkCliAuthRequiredError(null, null, {}, null);
  assert.match(e.message, /unknown/);
});
