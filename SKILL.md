---
name: lark
version: 0.2.0
description: Lark and Feishu communication channel
type: communication

lifecycle:
  npm: true
  service:
    name: zylos-lark
    entry: src/index.js
  data_dir: ~/zylos/components/lark
  hooks:
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js

upgrade:
  repo: zylos-ai/zylos-lark
  branch: main

config:
  required:
    - name: LARK_APP_ID
      description: 飞书/Lark 应用的 App ID
    - name: LARK_APP_SECRET
      description: 飞书/Lark 应用的 App Secret
      sensitive: true

dependencies:
  - comm-bridge
---

# Lark

Lark/Feishu communication channel for zylos.

## Dependencies

- comm-bridge (for C4 message routing)

## When to Use

- Receiving messages from Lark (private chat or @mention in groups)
- Sending messages via Lark
- Accessing Lark documents, spreadsheets, calendar
- Managing Lark groups and users

## How to Use

### Sending Messages

```bash
# Via C4 send interface
~/.claude/skills/lark/send.js <chat_id> "Hello!"

# Send image
~/.claude/skills/lark/send.js <chat_id> "[MEDIA:image]/path/to/image.png"

# Send file
~/.claude/skills/lark/send.js <chat_id> "[MEDIA:file]/path/to/file.pdf"
```

### CLI Commands

```bash
# Test authentication
npm run cli test

# Send messages
npm run cli send-group oc_xxx "Hello"

# Documents
npm run cli doc <doc_id>
npm run cli sheet-read <token> <range>

# Calendar
npm run cli calendar --days 7

# Groups
npm run cli chats
```

## Config Location

- Config: `~/zylos/components/lark/config.json`
- Logs: `~/zylos/components/lark/logs/`
- Media: `~/zylos/components/lark/media/`

## Environment Variables

Add to `~/zylos/.env`:

```bash
LARK_APP_ID=your_app_id
LARK_APP_SECRET=your_app_secret
```

## Owner

First user to send a private message becomes the owner (primary partner).
Owner is automatically whitelisted and can always communicate with the bot.

Owner info stored in config.json:
```json
{
  "owner": {
    "bound": true,
    "user_id": "xxx",
    "open_id": "ou_xxx",
    "name": "Howard"
  }
}
```

## Group Settings

### Allowed Groups (respond to @mentions)

Groups where the bot responds when @mentioned.
Owner can @mention bot in any group, even if not in allowed_groups.

```json
{
  "allowed_groups": [
    {"chat_id": "oc_xxx", "name": "研发群", "added_at": "2026-01-01T00:00:00Z"}
  ]
}
```

### Smart Groups (receive all messages)

Groups where the bot receives ALL messages without needing @mention:

```json
{
  "smart_groups": [
    {"chat_id": "oc_zzz", "name": "核心群", "added_at": "2026-01-01T00:00:00Z"}
  ]
}
```

## Service Management

```bash
pm2 status zylos-lark
pm2 logs zylos-lark
pm2 restart zylos-lark
```
