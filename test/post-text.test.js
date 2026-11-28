import test from 'node:test';
import assert from 'node:assert/strict';

import { extractPostText } from '../src/lib/post-text.js';

test('file-only rich posts expose every attachment instead of appearing empty', () => {
  const content = {
    title: '',
    content: [[]],
    content_v2: [[]],
    files: [
      { file_key: 'file_v3_first', file_name: 'first.pdf', is_folder: false },
      { file_key: 'file_v3_second', file_name: 'second.pdf', is_folder: false },
      { file_key: 'file_v3_third', file_name: 'third.pdf', is_folder: false },
    ],
  };

  assert.deepEqual(extractPostText(content, 'om_message'), {
    text: [
      '[file: first.pdf, file_key: file_v3_first, msg_id: om_message]',
      '[file: second.pdf, file_key: file_v3_second, msg_id: om_message]',
      '[file: third.pdf, file_key: file_v3_third, msg_id: om_message]',
    ].join('\n'),
    imageKeys: [],
  });
});

test('file metadata is preserved alongside text and other rich-post resources', () => {
  const content = {
    content: [
      [{ tag: 'text', text: 'Please review:' }],
      [
        { tag: 'img', image_key: 'img_v3_preview' },
        { tag: 'media', file_key: 'file_v3_video' },
      ],
    ],
    files: [{ file_key: 'file_v3_report', file_name: 'report.pdf' }],
  };

  assert.deepEqual(extractPostText(content, 'om_mixed'), {
    text: [
      'Please review:',
      '[image, image_key: img_v3_preview, msg_id: om_mixed]'
        + '[media, file_key: file_v3_video, msg_id: om_mixed]',
      '[file: report.pdf, file_key: file_v3_report, msg_id: om_mixed]',
    ].join('\n'),
    imageKeys: ['img_v3_preview'],
  });
});

test('file elements with missing fields still produce actionable non-empty metadata', () => {
  assert.deepEqual(extractPostText({ content: [[]], files: [{}] }, 'om_partial'), {
    text: '[file: unknown, file_key: unknown, msg_id: om_partial]',
    imageKeys: [],
  });
});

test('inline file elements and top-level files are not duplicated', () => {
  const file = { tag: 'file', file_key: 'file_v3_same', file_name: 'same.pdf' };
  assert.deepEqual(extractPostText({ content: [[file]], files: [file] }, 'om_same'), {
    text: '[file: same.pdf, file_key: file_v3_same, msg_id: om_same]',
    imageKeys: [],
  });
});
