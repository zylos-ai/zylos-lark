import test from 'node:test';
import assert from 'node:assert/strict';

function isSenderAllowed(allowFrom, senderUserId, senderOpenId, senderAppId) {
  if (!allowFrom || allowFrom.length === 0) return true;
  const allowed = allowFrom.map(s => String(s).toLowerCase());
  const normalizedSenderUserId = senderUserId === undefined || senderUserId === null ? '' : String(senderUserId).toLowerCase();
  const normalizedSenderOpenId = senderOpenId === undefined || senderOpenId === null ? '' : String(senderOpenId).toLowerCase();
  const normalizedSenderAppId = senderAppId === undefined || senderAppId === null ? '' : String(senderAppId).toLowerCase();
  if (allowed.includes('*')) return true;
  if (normalizedSenderUserId && allowed.includes(normalizedSenderUserId)) return true;
  if (normalizedSenderOpenId && allowed.includes(normalizedSenderOpenId)) return true;
  if (normalizedSenderAppId && allowed.includes(normalizedSenderAppId)) return true;
  return false;
}

test('group allowFrom can match app sender ids for bot-to-bot mentions', () => {
  assert.equal(isSenderAllowed(['cli_sender_bot'], null, null, 'cli_sender_bot'), true);
  assert.equal(isSenderAllowed(['CLI_SENDER_BOT'], null, null, 'cli_sender_bot'), true);
  assert.equal(isSenderAllowed(['ou_human'], null, null, 'cli_sender_bot'), false);
});

test('group allowFrom still matches user and open ids', () => {
  assert.equal(isSenderAllowed(['user_123'], 'user_123', 'ou_abc', null), true);
  assert.equal(isSenderAllowed(['ou_abc'], 'user_123', 'ou_abc', null), true);
  assert.equal(isSenderAllowed(['*'], null, null, 'cli_sender_bot'), true);
});

function isMentioned(mentions, botOpenId, botAppId = '') {
  if (!mentions || !Array.isArray(mentions)) return false;
  const normalizedBotOpenId = botOpenId === undefined || botOpenId === null ? '' : String(botOpenId);
  const normalizedBotAppId = botAppId === undefined || botAppId === null ? '' : String(botAppId);
  return mentions.some(m => {
    const mentionId = m.id?.open_id || m.id?.user_id || m.id?.app_id || '';
    const normalizedMentionId = String(mentionId);
    return (normalizedBotOpenId && normalizedMentionId === normalizedBotOpenId) ||
      (normalizedBotAppId && normalizedMentionId === normalizedBotAppId) ||
      m.key === '@_all';
  });
}

test('bot mention detection matches open_id and app_id mentions', () => {
  assert.equal(isMentioned([{ id: { open_id: 'ou_bot' } }], 'ou_bot', 'cli_bot'), true);
  assert.equal(isMentioned([{ id: { app_id: 'cli_bot' } }], 'ou_bot', 'cli_bot'), true);
  assert.equal(isMentioned([{ key: '@_all', id: {} }], 'ou_bot', 'cli_bot'), true);
  assert.equal(isMentioned([{ id: { app_id: 'cli_other' } }], 'ou_bot', 'cli_bot'), false);
});
