import test from 'node:test';
import assert from 'node:assert/strict';

import * as lark from '@larksuiteoapi/node-sdk';
import { resolveDomain } from '../src/lib/domain.js';

// Regression for the falsy-fallthrough bug: lark.Domain.Feishu === 0, so
// `DOMAIN_MAP[key] || lark.Domain.Lark` wrongly resolved 'feishu' to Lark
// International, causing WebSocket `code: 1000040351, system busy`.
test("'feishu' resolves to Domain.Feishu even though it is falsy (0)", () => {
  assert.equal(lark.Domain.Feishu, 0, 'precondition: Feishu enum is falsy');
  assert.equal(resolveDomain('feishu'), lark.Domain.Feishu);
});

test("'lark' resolves to Domain.Lark", () => {
  assert.equal(resolveDomain('lark'), lark.Domain.Lark);
});

test('unknown or missing keys fall back to Lark International', () => {
  assert.equal(resolveDomain('nope'), lark.Domain.Lark);
  assert.equal(resolveDomain(undefined), lark.Domain.Lark);
  assert.equal(resolveDomain(''), lark.Domain.Lark);
});
