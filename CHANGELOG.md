# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-beta.9] - 2026-02-09

### Changed
- Hook comments updated: hooks are now executed by Claude, not CLI
- Service restart is handled by Claude after hooks complete

---

## [0.1.0-beta.8] - 2026-02-08

### Added
- Lazy download for group file/image messages: log metadata (file_key, image_key, msg_id) instead of downloading immediately
- File metadata appears naturally in group context when bot is @mentioned later
- `download-file` CLI command for on-demand file download (`lark-cli download-file <msg_id> <file_key> <path>`)

---

## [0.1.0-beta.7] - 2026-02-08

### Fixed
- Resolve @_user_N placeholders to real names in group messages (context and current message)
- Only strip bot's @mention from current message, preserve other @mentions with resolved names
- Group permission: empty `allowed_groups` now means open access (all groups allowed), not closed access

### Added
- `resolveMentions()` function for Lark mention placeholder resolution

---

## [0.1.0-beta.6] - 2026-02-08

### Changed
- Version bump for C4 upgrade completion message testing

---

## [0.1.0-beta.5] - 2026-02-08

### Changed
- Post-install now shows full Feishu setup checklist (webhook URL, bot capability, event subscription, encrypt_key)
- SKILL.md: added complete Feishu console setup guide and encryption docs
- sendToC4 now retries once (2s delay) on failure

### Removed
- Config field `bot.verification_token` (never used in code)
- Config field `message.max_length` (send.js uses hardcoded constant instead)

---

## [0.1.0-beta.4] - 2026-02-08

### Fixed
- SKILL.md version now matches package.json

---

## [0.1.0-beta.3] - 2026-02-08

### Fixed
- Use bot open_id for @mention detection in groups (was failing to match)

---

## [0.1.0-beta.2] - 2026-02-08

### Added
- Admin CLI (`src/admin.js`) for managing groups, whitelist, and owner
- `enable-whitelist` / `disable-whitelist` commands in admin CLI
- DESIGN.md with full architecture documentation
- SKILL.md: `service.type: pm2`, `preserve` list for upgrade safety

### Changed
- Renamed `ecosystem.config.js` → `ecosystem.config.cjs` (aligned with telegram component)
- Updated `post-install.js` to reference `.cjs` ecosystem config
- Expanded `post-upgrade.js` with 9 config migrations (webhook_port, bot, owner, whitelist, allowed_groups, smart_groups, proxy, message)
- Adapted C4 interface for comm-bridge changes
- Moved `send.js` to `scripts/send.js`

### Fixed
- Fixed `scripts/send.js` import paths after move from root directory
- Fixed `add-whitelist` not to auto-enable whitelist (could lock out users)
- Added defensive array checks in `add-whitelist` for partial config edge case

---

## [0.1.0-beta.1] - 2026-02-05

### Added
- Owner auto-binding (first private chat user becomes owner)
- Owner can @mention bot in any group (even non-allowed)
- Smart groups support (receive all messages without @mention)
- Allowed groups support (respond to @mentions)
- Group context - include recent messages when responding to @mentions
- Group storage format with metadata: `{chat_id, name, added_at}`

### Changed
- Whitelist now checks owner status first (owner always allowed)
- SKILL.md updated with owner and group documentation

### Upgrade Notes

For existing installations, run:
```bash
zylos upgrade lark
```

If you have existing `allowed_groups` or `smart_groups` config with old format (array of strings),
you'll need to update to the new format:
```json
{
  "allowed_groups": [
    {"chat_id": "oc_xxx", "name": "Group Name", "added_at": "2026-02-05T00:00:00Z"}
  ]
}
```

---

## [0.1.0] - 2026-02-04

### Added
- Initial release
- Basic Lark/Feishu webhook integration
- Private chat and group chat support
- Message logging with group context
- Media download (images, files)
- C4 protocol integration via comm-bridge
- PM2 service management
