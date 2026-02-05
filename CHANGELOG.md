# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
