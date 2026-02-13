---
name: lark
version: 0.1.2
description: Lark and Feishu communication channel
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-lark
    entry: src/index.js
  data_dir: ~/zylos/components/lark
  hooks:
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - .env
    - data/

upgrade:
  repo: zylos-ai/zylos-lark
  branch: main

config:
  required:
    - name: LARK_APP_ID
      description: "App ID (Feishu: open.feishu.cn/app or Lark: open.larksuite.com/app -> Credentials)"
    - name: LARK_APP_SECRET
      description: "App Secret (same page as App ID)"
      sensitive: true

next-steps: "After starting the service: 1) Read domain from ~/zylos/.zylos/config.json and tell user to configure webhook URL in the developer console — Feishu: open.feishu.cn/app, Lark: open.larksuite.com/app (Event Subscriptions → Request URL → https://{domain}/lark/webhook). 2) Ask if user wants to configure verification token (optional, from Event Subscriptions page) — if yes, write to config.bot.verification_token in ~/zylos/components/lark/config.json, then pm2 restart zylos-lark."

http_routes:
  - path: /lark/webhook
    type: reverse_proxy
    target: localhost:3457
    strip_prefix: /lark

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
~/zylos/.claude/skills/lark/scripts/send.js <chat_id> "Hello!"

# Send image
~/zylos/.claude/skills/lark/scripts/send.js <chat_id> "[MEDIA:image]/path/to/image.png"

# Send file
~/zylos/.claude/skills/lark/scripts/send.js <chat_id> "[MEDIA:file]/path/to/file.pdf"
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

## Admin CLI

Manage bot configuration via `admin.js`:

```bash
# Show full config
node ~/zylos/.claude/skills/lark/src/admin.js show

# Allowed Groups (respond to @mentions)
node ~/zylos/.claude/skills/lark/src/admin.js list-allowed-groups
node ~/zylos/.claude/skills/lark/src/admin.js add-allowed-group <chat_id> <name>
node ~/zylos/.claude/skills/lark/src/admin.js remove-allowed-group <chat_id>

# Smart Groups (receive all messages, no @mention needed)
node ~/zylos/.claude/skills/lark/src/admin.js list-smart-groups
node ~/zylos/.claude/skills/lark/src/admin.js add-smart-group <chat_id> <name>
node ~/zylos/.claude/skills/lark/src/admin.js remove-smart-group <chat_id>

# Group Whitelist (enabled by default)
node ~/zylos/.claude/skills/lark/src/admin.js enable-group-whitelist
node ~/zylos/.claude/skills/lark/src/admin.js disable-group-whitelist

# Whitelist
node ~/zylos/.claude/skills/lark/src/admin.js list-whitelist
node ~/zylos/.claude/skills/lark/src/admin.js add-whitelist <user_id_or_open_id>
node ~/zylos/.claude/skills/lark/src/admin.js remove-whitelist <user_id_or_open_id>
node ~/zylos/.claude/skills/lark/src/admin.js enable-whitelist
node ~/zylos/.claude/skills/lark/src/admin.js disable-whitelist

# Owner info
node ~/zylos/.claude/skills/lark/src/admin.js show-owner

# Help
node ~/zylos/.claude/skills/lark/src/admin.js help
```

After changes, restart: `pm2 restart zylos-lark`

## Config Location

- Config: `~/zylos/components/lark/config.json`
- Logs: `~/zylos/components/lark/logs/`
- Media: `~/zylos/components/lark/media/`

## Feishu/Lark Setup

### 1. Credentials

Add to `~/zylos/.env`:

```bash
LARK_APP_ID=your_app_id
LARK_APP_SECRET=your_app_secret
```

Get App ID and App Secret from your app's Credentials page:
- Feishu: [open.feishu.cn/app](https://open.feishu.cn/app)
- Lark: [open.larksuite.com/app](https://open.larksuite.com/app)

### 2. Console Configuration

In the Feishu/Lark developer console:
- Feishu: [open.feishu.cn/app](https://open.feishu.cn/app)
- Lark: [open.larksuite.com/app](https://open.larksuite.com/app)

1. **Enable Bot capability**: Add capabilities → Bot (添加应用能力 → 机器人)
2. **Subscribe to events**: Event subscriptions → Add `im.message.receive_v1`
3. **Set Request URL**: Event subscriptions → Request URL → `https://<your-domain>/lark/webhook` (the path is defined by `http_routes` in SKILL.md)

### 3. Event Security (Optional)

Feishu/Lark provides two security mechanisms for webhook events. You can use either or both.

**Verification Token** — validates that requests come from Feishu/Lark:

In the console: Event subscriptions → Verification Token. Add to config:

```json
{
  "bot": {
    "verification_token": "your_verification_token_from_feishu"
  }
}
```

**Encrypt Key** — encrypts event payloads using AES-256-CBC:

In the console: Event subscriptions → Encrypt Key. Add to config:

```json
{
  "bot": {
    "encrypt_key": "your_encrypt_key_from_feishu"
  }
}
```

Both can be set together:

```json
{
  "bot": {
    "verification_token": "your_token",
    "encrypt_key": "your_key"
  }
}
```

### Cloudflare Users

If your domain is behind Cloudflare proxy with Flexible SSL mode, Caddy's automatic HTTPS will cause a redirect loop. Options:

1. **Change Cloudflare SSL to Full**: In Cloudflare dashboard → SSL/TLS → set mode to "Full" (recommended)
2. **Use HTTP mode**: Run `zylos config set protocol http` (automatically updates Caddyfile and reloads Caddy)

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

## Group Context

When responding to @mentions in groups, the bot includes recent message context
so Claude understands the conversation. Context is retrieved from logged messages
since the last response.

Configuration in `config.json`:
```json
{
  "message": {
    "context_messages": 10
  }
}
```

Message logs are stored in `~/zylos/components/lark/logs/<chat_id>.log`.

## Service Management

```bash
pm2 status zylos-lark
pm2 logs zylos-lark
pm2 restart zylos-lark
```
