# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.5] - 2026-02-17

### Added
- Thread context isolation: thread messages stored separately from group context (#37)
- Lazy load fallback: fetch message history from API on first access after restart (#37)
- Bot reply recording via `/internal/record-outgoing` endpoint with auth (#37)
- Typing indicator with emoji reaction and auto-timeout (#37)
- In-memory chat history with configurable limits per group (#37)
- XML message format with structured tags (thread-context, group-context, current-message, replying-to) (#37)
- Group policy system with per-group config (groupPolicy, allowed_from, history_limit) (#37)
- Structured endpoint routing with metadata (type, root, parent, msg, thread) (#37)
- Reply quoting: fetch quoted message content for context (#37)
- Multiple image support with lazy download (#37)
- User name cache with TTL (in-memory primary, file for cold start) (#37)
- Permission error detection with owner notification (#37)
- Markdown-aware message chunking (preserves code blocks) (#37)

### Security
- parseEndpoint key whitelist to prevent prototype pollution (#37)

### Changed
- Message dedup map now cleaned periodically via timer (#37)
- Typing indicator retry with deferred cleanup on failure (#37)
- Admin CLI: new group management commands (list-groups, add-group, set-group-policy, etc.) (#37)

## [0.1.4] - 2026-02-15

### Added
- Webhook message_id dedup with 5-min TTL to prevent duplicate processing (#33)
- Immediate HTTP 200 response before async message processing — prevents Lark timeout retries (#33)

### Changed
- Verification token is now REQUIRED — service refuses to start without it (#33)
- Post-install prompts for verification token directly (no longer optional y/N gate) (#33)
- Post-upgrade no longer deletes verification_token during migration (#33)

## [0.1.3] - 2026-02-14

### Changed
- Switch API domain from Feishu (open.feishu.cn) to Lark international (open.larksuite.com) (#29)

## [0.1.2] - 2026-02-13

### Fixed
- Add strip_prefix to webhook Caddy route (#25)
- Remove LARK_WEBHOOK_URL from required config — webhook URL now derived from domain (#26)
- Default group whitelist to deny-all except owner for security (#27)

### Added
- Group whitelist toggle: `enable-group-whitelist` / `disable-group-whitelist` admin commands (#27)

## [0.1.1] - 2026-02-12

### Added
- `http_routes` declaration in SKILL.md for automatic Caddy reverse proxy configuration (#22)
- Verification Token support for webhook request validation (#24)
- Cloudflare SSL compatibility documentation

### Fixed
- Improve post (rich text) message extraction (#23)

## [0.1.0] - 2026-02-11

Initial public release.

### Added
- Lark/Feishu webhook integration with event subscription
- Owner auto-binding (first private chat user becomes owner)
- Group support: allowed groups, smart groups, @mention detection
- Group context — include recent messages when responding to @mentions
- Mention resolution (@_user_N placeholders to real names)
- Media support: images, files with lazy download and on-demand retrieval
- C4 protocol integration with rejection response and retry
- Hooks-based lifecycle (post-install, post-upgrade, pre-upgrade)
- Admin CLI for managing groups, whitelist, and owner
- PM2 service management via ecosystem.config.cjs
