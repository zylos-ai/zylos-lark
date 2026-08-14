import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sendMedia,
  replyMedia,
  downloadResource,
  extractMessageId,
} from '../src/lib/lark-cli-bridge.js';
import {
  sendMediaThreadAware,
  directSendMedia,
  directReplyMedia,
} from '../src/lib/media-send.js';
import {
  cliSendMedia,
  cliDownloadMedia,
} from '../src/lib/cli-media.js';

/**
 * A recording runLarkCli seam. Returns a canned stdout, or throws when
 * `throwOn` matches the subcommand, so tests can drive both success and the
 * fallback-A path deterministically.
 */
function fakeRunner({ stdout = '{"ok":true,"data":{"message_id":"om_cli"}}', throwErr = null } = {}) {
  const calls = [];
  const run = (args, opts) => {
    calls.push({ args, opts });
    if (throwErr) throw throwErr;
    return stdout;
  };
  return { calls, run };
}

// ---------------------------------------------------------------------------
// sendMedia — bridge builds the correct lark-cli argv
// ---------------------------------------------------------------------------

test('sendMedia(image→chat) invokes lark-cli im +messages-send --as bot with cwd-relative --image', async () => {
  const { calls, run } = fakeRunner();
  let fbCalled = false;
  const res = await sendMedia(
    { chatId: 'oc_group1', kind: 'image', path: '/abs/dir/pic.png' },
    async () => { fbCalled = true; return { success: true, via: 'direct-api' }; },
    { run },
  );

  assert.equal(fbCalled, false, 'fallback must NOT run when lark-cli succeeds');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    'im', '+messages-send', '--as', 'bot',
    '--chat-id', 'oc_group1',
    '--image', 'pic.png',
  ]);
  assert.equal(calls[0].opts.cwd, '/abs/dir', 'absolute path must be split to cwd + basename');
  assert.equal(res.success, true);
  assert.equal(res.via, 'lark-cli');
  assert.equal(res.messageId, 'om_cli');
});

test('sendMedia(file→user) uses --user-id and --file', async () => {
  const { calls, run } = fakeRunner();
  await sendMedia(
    { userId: 'ou_bob', kind: 'file', path: '/tmp/report.pdf' },
    async () => ({ success: true }),
    { run },
  );
  assert.deepEqual(calls[0].args, [
    'im', '+messages-send', '--as', 'bot',
    '--user-id', 'ou_bob',
    '--file', 'report.pdf',
  ]);
  assert.equal(calls[0].opts.cwd, '/tmp');
});

test('sendMedia falls back to direct API when lark-cli throws, AFTER trying lark-cli', async () => {
  const order = [];
  const { calls, run } = fakeRunner({ throwErr: new Error('lark-cli exit 1') });
  const wrappedRun = (a, o) => { order.push('lark-cli'); return run(a, o); };
  const res = await sendMedia(
    { chatId: 'oc_x', kind: 'image', path: '/d/a.png' },
    async () => { order.push('fallback'); return { success: true, via: 'direct-api', messageId: 'om_direct' }; },
    { run: wrappedRun },
  );
  assert.equal(calls.length, 1, 'lark-cli must have been attempted');
  assert.deepEqual(order, ['lark-cli', 'fallback'], 'lark-cli tried first, then fallback');
  assert.equal(res.via, 'direct-api');
  assert.equal(res.messageId, 'om_direct');
  assert.equal(res.success, true);
});

test('sendMedia rejects unknown kind before touching lark-cli', async () => {
  const { calls, run } = fakeRunner();
  await assert.rejects(
    () => sendMedia({ chatId: 'oc_x', kind: 'video', path: '/d/a.mp4' }, async () => ({}), { run }),
    /unsupported kind/,
  );
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// replyMedia — thread flag preserved
// ---------------------------------------------------------------------------

test('replyMedia with replyInThread=true passes --reply-in-thread', async () => {
  const { calls, run } = fakeRunner();
  await replyMedia(
    { messageId: 'om_root', kind: 'image', path: '/x/y/a.png', replyInThread: true },
    async () => ({ success: true }),
    { run },
  );
  assert.deepEqual(calls[0].args, [
    'im', '+messages-reply', '--as', 'bot',
    '--message-id', 'om_root',
    '--image', 'a.png',
    '--reply-in-thread',
  ]);
  assert.equal(calls[0].opts.cwd, '/x/y');
});

test('replyMedia with replyInThread=false omits --reply-in-thread', async () => {
  const { calls, run } = fakeRunner();
  await replyMedia(
    { messageId: 'om_msg', kind: 'file', path: '/x/doc.pdf', replyInThread: false },
    async () => ({ success: true }),
    { run },
  );
  assert.deepEqual(calls[0].args, [
    'im', '+messages-reply', '--as', 'bot',
    '--message-id', 'om_msg',
    '--file', 'doc.pdf',
  ]);
  assert.ok(!calls[0].args.includes('--reply-in-thread'));
});

test('replyMedia falls back to direct API on lark-cli failure', async () => {
  const { run } = fakeRunner({ throwErr: new Error('boom') });
  let fbCalled = false;
  const res = await replyMedia(
    { messageId: 'om_1', kind: 'image', path: '/d/a.png', replyInThread: true },
    async () => { fbCalled = true; return { success: true, via: 'direct-api' }; },
    { run },
  );
  assert.equal(fbCalled, true);
  assert.equal(res.via, 'direct-api');
});

// ---------------------------------------------------------------------------
// downloadResource
// ---------------------------------------------------------------------------

test('downloadResource routes to +messages-resources-download with msg-id, file-key, safe output', async () => {
  const { calls, run } = fakeRunner({ stdout: '{"ok":true}' });
  let fbCalled = false;
  const res = await downloadResource(
    { messageId: 'om_1', fileKey: 'file_abc', type: 'file', outPath: '/save/dir/out.bin' },
    async () => { fbCalled = true; return { success: true, path: '/save/dir/out.bin' }; },
    { run },
  );
  assert.equal(fbCalled, false);
  assert.deepEqual(calls[0].args, [
    'im', '+messages-resources-download', '--as', 'bot',
    '--message-id', 'om_1',
    '--file-key', 'file_abc',
    '--type', 'file',
    '--output', 'out.bin',
  ]);
  assert.equal(calls[0].opts.cwd, '/save/dir', 'output must be relative to cwd (no absolute/.. traversal)');
  assert.equal(res.success, true);
  assert.equal(res.path, '/save/dir/out.bin');
  assert.equal(res.via, 'lark-cli');
});

test('downloadResource falls back to direct download on error', async () => {
  const { run } = fakeRunner({ throwErr: new Error('download failed') });
  let fbCalled = false;
  const res = await downloadResource(
    { messageId: 'om_1', fileKey: 'img_x', type: 'image', outPath: '/m/a.png' },
    async () => { fbCalled = true; return { success: true, path: '/m/a.png', message: 'direct' }; },
    { run },
  );
  assert.equal(fbCalled, true);
  assert.equal(res.path, '/m/a.png');
});

test('downloadResource propagates fallback failure (media-lost is reported, not swallowed)', async () => {
  const { run } = fakeRunner({ throwErr: new Error('lark down') });
  const res = await downloadResource(
    { messageId: 'om_1', fileKey: 'img_x', type: 'image', outPath: '/m/a.png' },
    async () => ({ success: false, message: 'direct also failed' }),
    { run },
  );
  assert.equal(res.success, false);
  assert.match(res.message, /direct also failed/);
});

// ---------------------------------------------------------------------------
// extractMessageId
// ---------------------------------------------------------------------------

test('extractMessageId digs message_id out of nested lark-cli envelopes', () => {
  assert.equal(extractMessageId('{"ok":true,"data":{"message_id":"om_a"}}'), 'om_a');
  assert.equal(extractMessageId('{"ok":true,"data":{"data":{"message_id":"om_b"}}}'), 'om_b');
  assert.equal(extractMessageId('noise\n{"ok":true,"data":{}}'), null);
  assert.equal(extractMessageId('not json'), null);
  assert.equal(extractMessageId(''), null);
});

// ---------------------------------------------------------------------------
// sendMediaThreadAware — routing (reply vs send) + threadInReply flag
// ---------------------------------------------------------------------------

function routingSpies() {
  const calls = { reply: [], send: [] };
  return {
    calls,
    deps: {
      larkReply: async (opts, fallback) => { calls.reply.push({ opts, fallback }); return { success: true, via: 'lark-cli' }; },
      larkSend: async (opts, fallback) => { calls.send.push({ opts, fallback }); return { success: true, via: 'lark-cli' }; },
    },
  };
}

test('routing: group topic thread → larkReply with replyInThread=true, reply target=parent||root', async () => {
  const { calls, deps } = routingSpies();
  await sendMediaThreadAware(
    { endpoint: { chatId: 'oc_g', type: 'group', root: 'om_root', parent: 'om_parent' }, type: 'image', path: '/d/a.png' },
    deps,
  );
  assert.equal(calls.send.length, 0, 'thread media must not use plain send');
  assert.equal(calls.reply.length, 1);
  assert.deepEqual(calls.reply[0].opts, {
    messageId: 'om_parent',
    kind: 'image',
    path: '/d/a.png',
    replyInThread: true,
  });
});

test('routing: group @mention (msg, no root) → larkReply with replyInThread=false', async () => {
  const { calls, deps } = routingSpies();
  await sendMediaThreadAware(
    { endpoint: { chatId: 'oc_g', type: 'group', msg: 'om_msg' }, type: 'file', path: '/d/f.pdf' },
    deps,
  );
  assert.equal(calls.reply.length, 1);
  assert.equal(calls.reply[0].opts.messageId, 'om_msg');
  assert.equal(calls.reply[0].opts.replyInThread, false);
});

test('routing: p2p DM → larkSend (no reply-to, media visible in 1:1 view)', async () => {
  const { calls, deps } = routingSpies();
  await sendMediaThreadAware(
    { endpoint: { chatId: 'oc_dm', type: 'p2p', msg: 'om_msg' }, type: 'image', path: '/d/a.png' },
    deps,
  );
  assert.equal(calls.reply.length, 0, 'p2p must never reply-to');
  assert.equal(calls.send.length, 1);
  assert.deepEqual(calls.send[0].opts, { chatId: 'oc_dm', kind: 'image', path: '/d/a.png' });
});

test('routing: end-to-end fallback — real bridge helper, throwing runner, direct spies deliver', async () => {
  // Wire the REAL sendMediaThreadAware + REAL larkSendMedia but a throwing
  // runner, and assert the direct-API fallback path actually sends.
  const throwing = () => { throw new Error('lark-cli absent'); };
  const directCalls = { upload: [], send: [] };
  const res = await sendMediaThreadAware(
    { endpoint: { chatId: 'oc_dm', type: 'p2p' }, type: 'image', path: '/d/a.png' },
    {
      // Use the real bridge sendMedia but force its runner to throw, and give a
      // direct fallback that records + succeeds.
      larkSend: (opts, fallback) => sendMedia(opts, fallback, { run: throwing }),
      directSend: async ({ chatId, type, path }) => {
        directCalls.upload.push(path);
        directCalls.send.push({ chatId, type });
        return { success: true, via: 'direct-api', messageId: 'om_direct' };
      },
    },
  );
  assert.equal(res.success, true);
  assert.equal(res.via, 'direct-api');
  assert.deepEqual(directCalls.upload, ['/d/a.png']);
  assert.deepEqual(directCalls.send, [{ chatId: 'oc_dm', type: 'image' }]);
});

test('sendMediaThreadAware rejects unsupported media type', async () => {
  await assert.rejects(
    () => sendMediaThreadAware({ endpoint: { chatId: 'oc', type: 'p2p' }, type: 'audio', path: '/x.opus' }, routingSpies().deps),
    /Unsupported media type/,
  );
});

// ---------------------------------------------------------------------------
// directReplyMedia — preserves the prior multi-level fallback chain
// ---------------------------------------------------------------------------

test('directReplyMedia: reply success returns without hitting root-reply or send', async () => {
  const calls = { upload: 0, reply: [], rootReply: 0, send: 0 };
  const res = await directReplyMedia(
    { chatId: 'oc_g', root: 'om_root', parent: 'om_parent', replyTarget: 'om_parent', type: 'image', path: '/d/a.png' },
    {
      uploadImage: async () => { calls.upload++; return { success: true, imageKey: 'img_1' }; },
      replyToMessage: async (target, content, t) => { calls.reply.push({ target, t }); return { success: true, messageId: 'om_r' }; },
      sendImage: async () => { calls.send++; return { success: true }; },
    },
  );
  assert.equal(calls.upload, 1);
  assert.deepEqual(calls.reply, [{ target: 'om_parent', t: 'image' }]);
  assert.equal(calls.send, 0);
  assert.equal(res.messageId, 'om_r');
});

test('directReplyMedia: parent reply fails → root reply → then chat send fallback', async () => {
  const seq = [];
  const res = await directSendMediaFallbackChain(seq);
  assert.deepEqual(seq, ['reply:om_parent', 'reply:om_root', 'send:oc_g']);
  assert.equal(res.success, true);
});

async function directSendMediaFallbackChain(seq) {
  return directReplyMedia(
    { chatId: 'oc_g', root: 'om_root', parent: 'om_parent', replyTarget: 'om_parent', type: 'file', path: '/d/f.pdf' },
    {
      uploadFile: async () => ({ success: true, fileKey: 'file_1' }),
      replyToMessage: async (target) => { seq.push(`reply:${target}`); return { success: false, message: 'nope' }; },
      sendFile: async (chatId) => { seq.push(`send:${chatId}`); return { success: true, messageId: 'om_s' }; },
    },
  );
}

// ---------------------------------------------------------------------------
// directSendMedia — hard failure throws (so bridge propagates media-lost)
// ---------------------------------------------------------------------------

test('directSendMedia throws when upload fails', async () => {
  await assert.rejects(
    () => directSendMedia({ chatId: 'oc', type: 'image', path: '/d/a.png' }, {
      uploadImage: async () => ({ success: false, message: 'upload down' }),
    }),
    /Failed to upload image: upload down/,
  );
});

// ---------------------------------------------------------------------------
// Manual CLI commands (cli-media.js) — deprecated but FUNCTIONAL.
// Regression guard: these must actually perform the op via lark-cli with a
// direct-API fallback, NOT revert to an exit-1 no-op.
// ---------------------------------------------------------------------------

test('cliSendMedia(image) invokes lark-cli im +messages-send --as bot with correct argv', async () => {
  const { calls, run } = fakeRunner();
  let fbCalled = false;
  const res = await cliSendMedia(
    { chatId: 'oc_x', type: 'image', path: '/tmp/a.png' },
    { run, directSend: async () => { fbCalled = true; return { success: true }; } },
  );
  assert.equal(fbCalled, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    'im', '+messages-send', '--as', 'bot',
    '--chat-id', 'oc_x',
    '--image', 'a.png',
  ]);
  assert.equal(res.success, true);
});

test('cliSendMedia(file) invokes lark-cli with --file and succeeds', async () => {
  const { calls, run } = fakeRunner();
  const res = await cliSendMedia(
    { chatId: 'oc_x', type: 'file', path: '/tmp/report.pdf' },
    { run },
  );
  assert.deepEqual(calls[0].args, [
    'im', '+messages-send', '--as', 'bot',
    '--chat-id', 'oc_x',
    '--file', 'report.pdf',
  ]);
  assert.equal(res.success, true);
});

test('cliSendMedia falls back to direct API when lark-cli fails, op STILL succeeds (order lark-cli→fallback)', async () => {
  const order = [];
  const throwing = (args) => { order.push('lark-cli'); throw new Error('lark-cli exit 1'); };
  const directSend = async ({ chatId, type, path }) => {
    order.push('fallback');
    // Discriminating: the fallback MUST actually be invoked (would fail the
    // old exit-1 no-op, which never called anything).
    return { success: true, via: 'direct-api', messageId: 'om_direct', _target: { chatId, type, path } };
  };
  const res = await cliSendMedia(
    { chatId: 'oc_x', type: 'image', path: '/tmp/a.png' },
    { run: throwing, directSend },
  );
  assert.deepEqual(order, ['lark-cli', 'fallback'], 'lark-cli tried first, then fallback');
  assert.equal(res.success, true, 'operation still succeeds via fallback → CLI exits 0');
  assert.equal(res.via, 'direct-api');
  assert.deepEqual(res._target, { chatId: 'oc_x', type: 'image', path: '/tmp/a.png' });
});

test('cliDownloadMedia(image) routes to +messages-resources-download with --as bot', async () => {
  const { calls, run } = fakeRunner({ stdout: '{"ok":true}' });
  let fbCalled = false;
  const res = await cliDownloadMedia(
    { messageId: 'om_1', fileKey: 'img_x', type: 'image', outPath: '/save/pic.png' },
    { run, downloadImage: async () => { fbCalled = true; return { success: true, path: '/save/pic.png' }; } },
  );
  assert.equal(fbCalled, false);
  assert.deepEqual(calls[0].args, [
    'im', '+messages-resources-download', '--as', 'bot',
    '--message-id', 'om_1',
    '--file-key', 'img_x',
    '--type', 'image',
    '--output', 'pic.png',
  ]);
  assert.equal(res.success, true);
  assert.equal(res.path, '/save/pic.png');
});

test('cliDownloadMedia(file) falls back to direct downloadFile on lark-cli failure and STILL delivers', async () => {
  const order = [];
  const throwing = () => { order.push('lark-cli'); throw new Error('lark down'); };
  const downloadFile = async (messageId, fileKey, outPath) => {
    order.push('fallback');
    return { success: true, path: outPath, message: 'File downloaded successfully' };
  };
  const res = await cliDownloadMedia(
    { messageId: 'om_1', fileKey: 'file_x', type: 'file', outPath: '/save/doc.pdf' },
    { run: throwing, downloadFile },
  );
  assert.deepEqual(order, ['lark-cli', 'fallback']);
  assert.equal(res.success, true);
  assert.equal(res.path, '/save/doc.pdf');
});

test('cliSendMedia surfaces hard failure (both paths fail) so CLI can exit non-zero', async () => {
  const throwing = () => { throw new Error('lark down'); };
  await assert.rejects(
    () => cliSendMedia(
      { chatId: 'oc_x', type: 'image', path: '/tmp/a.png' },
      { run: throwing, directSend: async () => { throw new Error('direct also down'); } },
    ),
    /direct also down/,
  );
});
