/**
 * The WebSocket transport must let the SDK ack an im.message.receive_v1 event
 * right away (#85). WSClient (@larksuiteoapi/node-sdk 1.59.0,
 * handleEventData) sends the ack frame only after
 * `eventDispatcher.invoke(data, { needCheck: false })` resolves, and Lark
 * re-pushes an event that is not processed within 3 seconds. Awaiting the
 * message pipeline inside the handler therefore re-delivered messages.
 *
 * Uses the real SDK EventDispatcher with a fake WSClient that captures it, and
 * invokes it the way WSClient.handleEventData does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWebSocketTransport } from '../src/lib/transport/websocket.js';

const CREATE_TIME = '1764300000000';

/** A v2 im.message.receive_v1 event, as WSClient decodes it from the frame. */
function receiveEvent(messageId) {
  return {
    schema: '2.0',
    header: {
      event_id: `ev_${messageId}`,
      event_type: 'im.message.receive_v1',
      create_time: CREATE_TIME,
      token: '',
      app_id: 'cli_test',
      tenant_key: 'tenant',
    },
    event: {
      sender: { sender_id: { open_id: 'ou_sender', user_id: 'u_sender' }, sender_type: 'user' },
      message: {
        message_id: messageId,
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: '{"text":"hi"}',
        create_time: CREATE_TIME,
      },
    },
  };
}

async function startTransport(t, { handleMessageEvent, isDuplicate = () => false }) {
  const clients = [];
  class FakeWSClient {
    constructor() {
      clients.push(this);
      this.wsConfig = { getWS: () => undefined, getWSInstance: () => null };
    }
    async handleControlData() {}
    async start({ eventDispatcher }) { this.eventDispatcher = eventDispatcher; }
    close() {}
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-ws-ack-'));
  const tr = createWebSocketTransport({
    WSClient: FakeWSClient,
    stateFile: path.join(dir, 'ws-restart-state.json'),
    setIntervalFn: () => ({ unref() { return this; } }),
    clearIntervalFn: () => {},
    log: { log() {}, warn() {}, error() {} },
  });
  t.after(() => {
    tr.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await tr.start({ domain: 'lark' }, { app_id: 'cli_test', app_secret: 'test-secret' }, handleMessageEvent, isDuplicate);
  return clients[0].eventDispatcher;
}

/** Resolves 'acked' if invoke() settles within 200ms, else 'pending'. */
function ackOutcome(dispatcher, data) {
  return Promise.race([
    dispatcher.invoke(data, { needCheck: false }).then(() => 'acked'),
    new Promise((resolve) => setTimeout(resolve, 200, 'pending')),
  ]);
}

test('the event is acked while the message pipeline is still running (#85)', async (t) => {
  const events = [];
  let finish;
  const dispatcher = await startTransport(t, {
    handleMessageEvent: (event) => {
      events.push(event);
      return new Promise((resolve) => { finish = resolve; });
    },
  });

  assert.equal(await ackOutcome(dispatcher, receiveEvent('om_1')), 'acked');
  const { message, sender } = receiveEvent('om_1').event;
  assert.deepEqual(events, [{ event: { message, sender }, header: { create_time: CREATE_TIME } }],
    'the pipeline still gets the webhook-shaped event');
  finish();
});

test('a failing message pipeline is logged and the event is still acked', async (t) => {
  const errors = [];
  const origError = console.error;
  console.error = (msg) => errors.push(msg);
  t.after(() => { console.error = origError; });
  const dispatcher = await startTransport(t, {
    handleMessageEvent: (event) => {
      if (event.event.message.message_id === 'om_sync') throw new Error('sync failure');
      return Promise.reject(new Error('async failure'));
    },
  });

  assert.equal(await ackOutcome(dispatcher, receiveEvent('om_sync')), 'acked');
  assert.equal(await ackOutcome(dispatcher, receiveEvent('om_async')), 'acked');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['[lark] WS pipeline error: sync failure', '[lark] WS pipeline error: async failure']);
});

test('a duplicate message_id never reaches the message pipeline', async (t) => {
  const events = [];
  const dispatcher = await startTransport(t, {
    handleMessageEvent: async (event) => { events.push(event.event.message.message_id); },
    isDuplicate: (messageId) => messageId === 'om_dup',
  });

  assert.equal(await ackOutcome(dispatcher, receiveEvent('om_dup')), 'acked');
  assert.equal(await ackOutcome(dispatcher, receiveEvent('om_new')), 'acked');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['om_new']);
});
