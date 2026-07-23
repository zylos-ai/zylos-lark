import test from 'node:test';
import assert from 'node:assert/strict';

import { extractInteractiveText } from '../src/lib/card-text.js';

// Regression: a div/field-layout card (e.g. an approval / "折扣申请" application
// card) read back with only "[card] <title>". Its text lives in the `div`
// component's `fields[].text.content`, which the old walker dropped (it read
// only `div.text`). This is the real read-back shape captured live from the API
// with card_msg_content_type=user_card_content: top-level `elements[]` with
// `div` elements carrying `fields[]`, plus an `action` button.
const approvalCard = {
  config: {},
  header: { title: { content: '折扣申请', tag: 'plain_text' } },
  elements: [
    { tag: 'hr' },
    { tag: 'div', fields: [
      { is_short: false, text: { tag: 'lark_md', content: '<at id=ou_x></at> Operations' } },
    ] },
    { tag: 'div', fields: [
      { is_short: false, text: { tag: 'lark_md', content: '申请原因说明:  申请折扣码 pro 两周试用；\n数量：1个；\n特批领导：Charlie；\n渠道来源：微信-Faraday Future；\n支付方式：待定' } },
      { is_short: false, text: { tag: 'lark_md', content: '是否为特定用户:  否' } },
      { is_short: false, text: { tag: 'lark_md', content: '折扣类型:  固定金额减免' } },
    ] },
    { tag: 'action', actions: [
      { tag: 'button', text: { tag: 'plain_text', content: '查看详情' } },
    ] },
  ],
};

test('div card: extracts ALL fields[].text.content (not just the title)', () => {
  const out = extractInteractiveText(approvalCard);
  assert.notEqual(out, '[card] 折扣申请', 'must not fall back to title-only');
  assert.match(out, /申请原因说明/);
  assert.match(out, /特批领导：Charlie/);
  assert.match(out, /是否为特定用户/);
  assert.match(out, /折扣类型/);
  assert.match(out, /固定金额减免/);
  assert.match(out, /查看详情/, 'action button text included');
});

test('div card with a main `text` (no fields) still extracted', () => {
  const c = { elements: [{ tag: 'div', text: { tag: 'lark_md', content: '一段说明文字' } }] };
  assert.equal(extractInteractiveText(c), '一段说明文字');
});

test('schema 2.0 markdown card (body.elements) extracted', () => {
  const c = { schema: '2.0', header: { title: { content: 'x' } }, body: { elements: [
    { tag: 'markdown', content: '第一段' },
    { tag: 'hr' },
    { tag: 'markdown', content: '第二段' },
  ] } };
  assert.equal(extractInteractiveText(c), '第一段\n第二段');
});

test('column_set card: text inside columns[].elements[] is extracted', () => {
  const c = { schema: '2.0', body: { elements: [
    { tag: 'column_set', columns: [
      { tag: 'column', elements: [{ tag: 'markdown', content: '**折扣码**\n`OIMWZMUD`' }] },
      { tag: 'column', elements: [{ tag: 'div', fields: [{ text: { content: '状态: 未使用' } }] }] },
    ] },
  ] } };
  const out = extractInteractiveText(c);
  assert.match(out, /OIMWZMUD/);
  assert.match(out, /状态: 未使用/, 'div fields inside a column are read');
});

test('user_dsl (original card preserved) is preferred', () => {
  const c = { user_dsl: JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: '原始正文' }] } }),
              title: 'transformed-title' };
  assert.equal(extractInteractiveText(c), '原始正文');
});

test('legacy 2D array of text runs is extracted', () => {
  const c = { title: 't', elements: [[{ tag: 'text', text: 'hello ' }, { tag: 'lark_md', content: 'world' }]] };
  assert.equal(extractInteractiveText(c), 'hello\nworld');
});

test('title fallback only when no element text is present (e.g. image-only render)', () => {
  const c = { title: '仅标题', elements: [[{ tag: 'img', image_key: 'img_x' }, { tag: 'text', text: ' ' }]] };
  assert.equal(extractInteractiveText(c), '[card] 仅标题');
});

test('unrecognized/empty card returns the placeholder', () => {
  assert.equal(extractInteractiveText({}), '[interactive message]');
  assert.equal(extractInteractiveText(null), '[interactive message]');
});
