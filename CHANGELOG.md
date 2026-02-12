# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
