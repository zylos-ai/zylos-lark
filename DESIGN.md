# zylos-lark Design Document

**Version**: v1.0
**Date**: 2026-02-08
**Author**: Zylos Team
**Repository**: https://github.com/zylos-ai/zylos-lark
**Status**: Implemented

---

## 1. Overview

### 1.1 Component Overview

zylos-lark is a Zylos communication component that enables bidirectional messaging between users and the Claude Agent via the Lark/Feishu Webhook API.

| Property | Value |
|----------|-------|
| Type | Communication |
| Priority | P0 |
| Dependency | C4 Communication Bridge |
| Base Code | zylos-infra/lark-agent (~80% reused) |

### 1.2 Core Features

| Feature | Description | Priority |
|---------|-------------|----------|
| Direct message receiving | Receive direct messages from authorized users | P0 |
| Message sending | Send messages to specified users/groups via C4 | P0 |
| Auto owner binding | First direct message user automatically becomes admin | P0 |
| User whitelist | Restrict usage to authorized users only | P0 |
| Group @mention | Receive @bot messages in group chats | P1 |
| Smart Groups | Receive all messages from designated groups | P1 |
| Image receiving | Download and pass image paths to Claude | P1 |
| File receiving | Download and pass file paths to Claude | P2 |
| Group context | Include recent group messages with @mentions | P1 |

### 1.3 Out of Scope

- Voice message handling
- Video processing
- Lark approval/calendar creation (handled via CLI)
- Lark interactive card messages

---

## 2. Directory Structure

### 2.1 Skills Directory (Code)

```
~/zylos/.claude/skills/lark/
├── SKILL.md              # Component metadata (v2 format with lifecycle)
├── package.json          # Dependency definitions
├── ecosystem.config.cjs  # PM2 configuration
├── scripts/
│   └── send.js           # C4 standard send interface
├── hooks/
│   ├── post-install.js   # Post-install hook (create dirs, configure PM2)
│   ├── pre-upgrade.js    # Pre-upgrade hook (backup config)
│   └── post-upgrade.js   # Post-upgrade hook (config migration)
└── src/
    ├── index.js          # Main entry point (Webhook server)
    ├── cli.js            # Lark API CLI tool
    ├── admin.js          # Admin CLI
    └── lib/
        ├── config.js     # Configuration loader
        ├── client.js     # API auth client
        ├── message.js    # Message send/receive
        ├── document.js   # Document/spreadsheet operations
        ├── calendar.js   # Calendar queries
        ├── chat.js       # Group management
        └── contact.js    # Contact lookup
```

### 2.2 Data Directory (Runtime Data)

```
~/zylos/components/lark/
├── config.json           # Runtime configuration
├── group-cursors.json    # Group message cursors (tracks processed messages)
├── user-cache.json       # User name cache
├── media/                # Media file storage (images, files, etc.)
└── logs/                 # Log directory (managed by PM2)
    ├── out.log
    ├── error.log
    └── <chat_id>.log     # Per-conversation message logs
```

---

## 3. Architecture

### 3.1 Component Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                     zylos-lark                           │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐    ┌──────────────┐                   │
│  │  index.js    │───▶│  config.js   │                   │
│  │  (Express)   │    │  Whitelist+Owner                 │
│  └──────┬───────┘    └──────────────┘                   │
│         │                                                │
│         │ Webhook receive                                │
│         ▼                                                │
│  ┌──────────────┐                                       │
│  │  message.js  │  Download media locally                │
│  └──────┬───────┘                                       │
│         │                                                │
│         ▼                                                │
│  ┌──────────────────────────────────┐                   │
│  │ c4-receive (comm-bridge)         │ → C4 Bridge       │
│  └──────────────────────────────────┘                   │
│                                                          │
│  ┌──────────────┐                                       │
│  │  send.js     │  ← Called by C4 to send messages      │
│  └──────────────┘                                       │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Module Responsibilities

| Module | File | Responsibility |
|--------|------|----------------|
| Main | index.js | Express Webhook server, event handling, message formatting, calling c4-receive |
| Config | lib/config.js | Load .env + config.json, hot-reload configuration |
| Client | lib/client.js | Lark API authentication (app_id + app_secret -> tenant_access_token) |
| Message | lib/message.js | Send/receive messages, file upload/download |
| Document | lib/document.js | Document reading, spreadsheet read/write |
| Calendar | lib/calendar.js | Calendar event queries |
| Chat | lib/chat.js | Group listing, search, member queries |
| Contact | lib/contact.js | User information lookup |
| Send | scripts/send.js | C4 standard interface for sending text and media |
| Admin | src/admin.js | CLI for managing config (groups, whitelist, owner) |
| CLI | src/cli.js | Lark API command-line tool |

---

## 4. C4 Integration

### 4.1 Receive Flow (Lark -> Claude)

```
User sends message
     │
     ▼
┌─────────────┐
│  index.js   │  Listens for Lark Webhooks
└─────┬───────┘
      │ 1. Decrypt (if encrypt_key is set)
      │ 2. Owner / whitelist validation
      │ 3. Group permission check
      ▼
┌─────────────┐
│ Format msg  │
└─────┬───────┘
      │ Format: "[Lark DM] username said: message content"
      │         "[Lark GROUP] username said: [context] message content"
      ▼
┌─────────────┐
│ c4-receive  │  C4 Bridge interface
└─────┬───────┘
      │ --channel lark
      │ --endpoint <chat_id>
      │ --content "..."
      ▼
┌─────────────┐
│   Claude    │  Processes message
└─────────────┘
```

### 4.2 Send Flow (Claude -> Lark)

```
Claude needs to reply
      │
      ▼
┌─────────────┐
│  c4-send    │  C4 Bridge
└─────┬───────┘
      │ c4-send lark <chat_id> "message content"
      ▼
┌──────────────────────────────────────┐
│ ~/zylos/.claude/skills/lark/scripts/send.js │
└─────┬────────────────────────────────┘
      │ 1. Parse arguments
      │ 2. Check for media prefix [MEDIA:type]
      │ 3. Call Lark API
      ▼
┌─────────────┐
│ Lark        │  User receives message
└─────────────┘
```

### 4.3 send.js Interface Specification

```bash
# Location: ~/zylos/.claude/skills/lark/scripts/send.js
# Usage: node send.js <chat_id> <message>
# Returns: 0 on success, non-zero on failure

# Plain text
node send.js "oc_xxx" "Hello!"

# Send image
node send.js "oc_xxx" "[MEDIA:image]/path/to/photo.jpg"

# Send file
node send.js "oc_xxx" "[MEDIA:file]/path/to/document.pdf"
```

### 4.4 Message Format Specification

**Incoming message format:**

```
# Direct message
[Lark DM] Howard said: Hello

# Group @mention (with context)
[Lark GROUP] Howard said: [Group context - recent messages before this @mention:]
[Alice]: Do we need to deploy today?
[Bob]: Let me confirm first

[Current message:] @Zylos Can you take a look

# With image
[Lark DM] Howard said: [image] What is this ---- file: ~/zylos/components/lark/media/lark-xxx.png
```

---

## 5. Configuration

### 5.1 config.json Structure

```json
{
  "enabled": true,
  "webhook_port": 3457,

  "bot": {
    "encrypt_key": ""
  },

  "owner": {
    "bound": false,
    "user_id": "",
    "open_id": "",
    "name": ""
  },

  "whitelist": {
    "enabled": false,
    "private_users": [],
    "group_users": []
  },

  "allowed_groups": [],
  "smart_groups": [],

  "proxy": {
    "enabled": false,
    "host": "",
    "port": 0
  },

  "message": {
    "context_messages": 10
  }
}
```

### 5.2 Configuration Reference

| Field | Type | Description |
|-------|------|-------------|
| enabled | boolean | Component enable/disable toggle |
| webhook_port | number | Webhook listening port |
| bot.encrypt_key | string | Lark event encryption key (optional) |
| owner.bound | boolean | Whether an owner has been bound |
| owner.user_id | string | Owner's user_id |
| owner.open_id | string | Owner's open_id |
| owner.name | string | Owner's display name |
| whitelist.enabled | boolean | Whitelist enable/disable toggle |
| whitelist.private_users | string[] | Whitelisted users for direct messages |
| whitelist.group_users | string[] | Whitelisted users for group chats |
| allowed_groups | object[] | Groups where @mention is allowed |
| smart_groups | object[] | Groups where all messages are monitored |
| proxy.enabled | boolean | Proxy enable/disable toggle |
| message.context_messages | number | Number of group context messages to include |

### 5.3 Environment Variables (~/zylos/.env)

```bash
# Lark App credentials (required)
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
```

---

## 6. Security

### 6.1 Auto Owner Binding

**Design principle**: The first user to send a direct message automatically becomes the owner (admin).

```
User sends direct message
      │
      ▼
┌─────────────────┐
│ Check owner     │
│ bound == false? │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
  Unbound    Bound
    │         │
    ▼         ▼
Bind as owner  Proceed with normal validation
Save config
```

**Recorded on binding**: user_id, open_id, name

### 6.2 User Validation Flow

```
User sends message
      │
      ▼
┌─────────────────┐
│ Is owner?       │ → Yes → Allow
└────────┬────────┘
         │ No
         ▼
┌─────────────────┐
│ Whitelist off?  │ → Yes → Allow
└────────┬────────┘
         │ No (whitelist enabled)
         ▼
┌─────────────────┐
│ On whitelist?   │ → Yes → Allow
└────────┬────────┘
         │ No
         ▼
       Ignore message
```

### 6.3 Group Permissions

| Group Type | @mention response | Receive all messages | Permission required |
|------------|:-----------------:|:--------------------:|---------------------|
| smart_groups | Y | Y | None |
| allowed_groups | Y | N | Whitelist or Owner |
| Other groups | Owner only | N | Owner only |

---

## 7. Differences from Telegram Component

| Aspect | zylos-telegram | zylos-lark |
|--------|---------------|------------|
| Protocol | Telegram Bot API (long polling) | Lark Webhook (HTTP POST) |
| Entry point | bot.js (Telegraf) | index.js (Express) |
| Authentication | Bot Token | App ID + Secret -> tenant_access_token |
| Message encryption | None | AES-256-CBC (optional) |
| Owner identifier | chat_id + username | user_id + open_id |
| Whitelist structure | chat_ids[] + usernames[] | private_users[] + group_users[] |
| CLI tool | None | cli.js (documents/spreadsheets/calendar/groups) |
| Additional features | None | Spreadsheet read/write, document access, calendar queries |

---

## 8. Service Management

### 8.1 PM2 Configuration

```javascript
// ecosystem.config.cjs
const path = require('path');
const os = require('os');

module.exports = {
  apps: [{
    name: 'zylos-lark',
    script: 'src/index.js',
    cwd: path.join(os.homedir(), 'zylos/.claude/skills/lark'),
    env: { NODE_ENV: 'production' }
  }]
};
```

### 8.2 Service Commands

```bash
pm2 start ~/zylos/.claude/skills/lark/ecosystem.config.cjs
pm2 stop zylos-lark
pm2 restart zylos-lark
pm2 logs zylos-lark
```

---

## 9. Lifecycle Management (v2 Hooks)

### 9.1 Install/Uninstall Flow

```bash
# Install
zylos install lark
# 1. git clone to ~/zylos/.claude/skills/lark
# 2. npm install
# 3. Create data_dir
# 4. Register PM2 service
# 5. Execute post-install hook

# Upgrade
zylos upgrade lark
# 1. pre-upgrade hook (backup config)
# 2. git pull
# 3. npm install
# 4. post-upgrade hook (config migration)
# 5. PM2 restart service

# Uninstall
zylos uninstall lark [--purge]
# 1. Remove PM2 service
# 2. Delete skill directory
# 3. --purge: delete data directory
```

---

## 10. Acceptance Criteria

- [ ] `zylos install lark` completes installation on a fresh environment
- [ ] `node send.js <chat_id> <message>` sends messages correctly
- [ ] Direct messages are correctly forwarded to c4-receive
- [ ] Group @mentions include context and are forwarded to c4-receive
- [ ] Images are downloaded and their paths are passed through
- [ ] Auto owner binding flow works correctly
- [ ] Owner can @bot in any group to trigger a response
- [ ] admin.js correctly manages configuration
- [ ] `zylos upgrade lark` preserves user config and performs migration
- [ ] `zylos uninstall lark` cleans up correctly

---

## Appendix

### A. Dependencies

```json
{
  "dependencies": {
    "@larksuiteoapi/node-sdk": "^1.0.0",
    "axios": "^1.6.0",
    "dotenv": "^16.4.5",
    "express": "^4.18.2",
    "form-data": "^4.0.0"
  }
}
```

### B. References

- [Lark Open Platform Documentation](https://open.feishu.cn/document/)
- [Lark Node SDK](https://github.com/larksuite/node-sdk)
- [zylos-telegram DESIGN.md](../zylos-telegram/DESIGN.md)

---

*End of document*
