# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.3] - 2026-06-28

### Changed
- **Version-aware lark-cli upgrade**: install and upgrade hooks now compare
  the installed `lark-cli` version against the target declared in
  `package.json` (`larkCli.version`) and only upgrade when behind, instead
  of skipping whenever any version is already present. Sub-skills installed
  via `xc-skills` are tracked with a `.lark-cli-version` marker file and
  re-fetched when the target advances. Future lark-cli bumps require only a
  one-field change in `package.json`.
- **lark-cli target bumped `1.0.41` → `1.0.59`** (27 sub-skills, adds
  `lark-note`).

## [0.3.2] - 2026-06-09

### Fixed
- **Interactive (markdown) cards now resolve their content on all three
  message paths** instead of coming through as `[interactive message]`.
  When Lark pushes or returns a card it transforms it and drops the
  markdown body from the top-level fields — the rendered form left in
  `elements[]` is often just an image. `extractInteractiveText` now also
  reads the original card preserved under `user_dsl` (a JSON string of
  `{ body: { elements: [...] }, schema }`), which is the only source
  available on the inbound webhook push (it has no API call to attach a
  parameter to). The element-walking logic is factored into a shared
  `walkSchema2Elements` helper, and diagnostic logging is restored for
  unrecognized card schemas (#87).

### Added
- **`card_msg_content_type: 'user_card_content'` on the history
  (`listMessages`) and quoted (`fetchQuotedMessage`) fetch paths.** This asks
  the API to return the **original card JSON** (the Schema 2.0 card as sent,
  with `body.elements[...]`) rather than the transformed/rendered form, whose
  top-level `elements[]` drops the markdown body. The API does not resolve the
  card to plain text — it returns the original card JSON, which carries
  `body.elements` that the same `extractInteractiveText` then reads. Combined
  with the inbound `user_dsl` fix, all three card paths — inbound push,
  history context, and quoted reply — now extract content correctly (#87).

## [0.3.1] - 2026-05-27

### Security
- **Cleared 9 npm production-dependency vulnerabilities** (6 moderate,
  2 high, 1 critical) reported by `npm audit --omit=dev`. Affected
  packages: `protobufjs` (critical: code execution, prototype pollution,
  DoS), `axios` (high: SSRF, prototype pollution, header injection, and
  13 others), `@protobufjs/utf8`, `follow-redirects`, `qs`, `body-parser`,
  `express`, `ws` (moderate). After fix: `npm audit` reports 0
  vulnerabilities (#82).

### Changed
- **`axios` direct dep bumped `^1.6.0` → `^1.16.0`**, plus a
  package.json `overrides` entry forces the entire dependency tree —
  including `@larksuiteoapi/node-sdk@1.59.0`, which declares `axios
  ~1.13.3` — onto `^1.16.0` as well. The SDK keeps running on its
  current minor (1.59.0) and resolves a single deduped `axios@1.16.1`
  rather than being downgraded to 1.56.1 by `npm audit fix --force`.
- All other affected indirect deps were upgraded through the safe
  `npm audit fix` path (no breaking changes).

## [0.3.0] - 2026-05-27

### Compatibility

- **Requires zylos-core > 0.5.0** (0.5.0 itself is not enough). The
  post-upgrade hook checks the installed core version on first run and
  aborts with a clear message if the core is 0.5.0 or older. Unknown /
  unparsable core versions also abort (fail-closed). Run
  `zylos upgrade --self` first, then `zylos upgrade lark` (#78).

### Added
- **Bundled lark-cli integration**: `npm install -g @larksuite/cli@1.0.41`
  runs automatically during install/upgrade. The 25 lark-cli sub-skills
  (lark-im, lark-contact, lark-doc, lark-sheets, lark-slides,
  lark-markdown, lark-drive, lark-wiki, lark-whiteboard, lark-base,
  lark-calendar, lark-task, lark-mail, lark-approval, lark-attendance,
  lark-okr, lark-vc, lark-vc-agent, lark-minutes,
  lark-workflow-meeting-summary, lark-workflow-standup-report,
  lark-event, lark-openapi-explorer, lark-skill-maker, lark-shared) are
  installed under `references/` via
  `npx xc-skills add github:larksuite/cli#v1.0.41`, and LARK_APP_ID /
  LARK_APP_SECRET are pushed into lark-cli's keychain via
  `lark-cli config init`. All three steps are idempotent (#78).
- `src/lib/lark-cli-bridge.js` with test coverage — helper library
  exposing `runLarkCli()` and `notifyOwnerAuthRequired()` for Node code
  that needs to invoke lark-cli programmatically. **Not on the default
  call path**: agents invoke lark-cli via shell and handle auth errors
  themselves; the bridge is provided for future Node-side integrations
  (#78).

### Changed
- **Message envelope format**: the `<sender> said:` label has moved
  from the outer envelope into `<current-message>`. The outer line now
  contains only the channel marker (e.g. `[Lark GROUP:xxx]`), and the
  current message body becomes
  `<current-message>\n<sender> said: <text>\n</current-message>`. This
  removes the ambiguity where `said:` appeared to label the whole
  envelope including `<group-context>`. Affects both DM and group
  messages; `<thread-context>`, `<replying-to>`, and `<smart-mode>`
  blocks unchanged.
- **`SENDER_NAME_TTL` extended from 10 minutes to 1 hour.** Reduces
  frequency of cache misses that hit `contact.user.get` — that endpoint
  often fails with `41050 no user authority error` on cross-tenant or
  out-of-visibility users, which configuring per-scope visibility in
  the Lark console does not always resolve. Longer TTL reduces both
  background API load and visible-ID fallback windows.
- **lark-cli upstream pinned to `v1.0.41`**: both `npm install -g
  @larksuite/cli` and `npx xc-skills add github:larksuite/cli` now
  include explicit version selectors. A single `LARK_CLI_VERSION`
  constant in `hooks/post-install-shared.js` drives both; bumping the
  upstream version is a one-line change. `xc-skills` tool itself
  remains `@latest`.

### Fixed
- Post-upgrade hook now backs up `config.json` to
  `config.json.backup.<ISO-timestamp>` before mutation and uses atomic
  write (temp + rename with unique suffix and failure cleanup) for the
  new config (#78).
- `installLarkCliSkills` now audits all 25 expected sub-skills instead
  of probing a single `lark-im/SKILL.md` file. Partial-install state
  (aborted prior run, manually removed folders) is repaired instead of
  silently skipped, and a post-install verification ensures the repair
  succeeded (#78).
- **User name resolution under cache expiry**: previously, after
  `SENDER_NAME_TTL` expired and `getUserInfo` returned a non-throw
  failure (e.g. code 41050), `resolveUserName` fell back to the raw
  `user_id` / `open_id` and `<group-context>` rendered an opaque ID
  like `[662g9179]`. The stale-cache fallback that already existed in
  the `throw` path is now applied to all failure paths, so the cached
  name is preferred over the raw ID; the ID is used only when no cache
  history exists for the user.
- **`_preloadedGroups` lifetime**: replaced the permanent `Set` marker
  with a `Map<chatId, lastPreloadAt>` and a `PRELOAD_TTL` of 1 hour.
  Previously, once a group had been preloaded it could never be
  re-preloaded, so expired user cache entries had no recovery path
  even though the `im.chat.members` endpoint (which does not need
  contact visibility) was available. Each group now re-preloads at
  most once per hour.
- **Preload skipped expired entries**: `preloadGroupMembers` used
  `!userCacheMemory.has(memberId)` to decide whether to update the
  cache. `Map.has()` returns true for expired entries (entries are
  never physically deleted), so the loop body was a no-op after the
  first run. The condition is now `!existing || existing.expireAt <= now`
  so preload genuinely reseeds the cache after entries expire.
- **Preload ordering**: `preloadGroupMembers` now runs before
  `logMessage` in the `@mention` / smart group branch. The first
  message in a fresh group previously logged as `[user_id]` because
  the cache was empty when `resolveUserName` first ran; now the cache
  is warm before `resolveUserName` is invoked. No change to the
  no-`@mention` pass-through branch.

### Removed
- Reverted in-config `_legacy_*` field injection introduced in 7cd2090
  (`_legacy_whitelist`, `_legacy_group_whitelist`,
  `_legacy_message_max_length`) in favor of whole-file backups; the
  original config schema is preserved. Pre-existing `_legacy_*`
  references in main are untouched (#78).

## [0.2.3] - 2026-04-13

### Fixed
- CLI `messages` command now displays in chronological order (oldest first) instead of reverse
- CLI `messages` command now resolves sender open_id to real names via group member lookup (#74)
- CLI `messages` command replaces `@_user_N` mention placeholders with real display names (#74)
- CLI `members` command defaults to `user_id` format for consistency with webhook path (#74)
- Webhook `preloadGroupMembers` now explicitly requests `user_id` format to match event sender IDs (closes #73)

## [0.2.2] - 2026-04-02

### Fixed
- Markdown-card auto-detection now preserves plain text replies as normal text messages while still rendering markdown content as interactive cards (#69)
- Runtime config loading now preserves nested `message.useMarkdownCard` defaults for partial configs (#69)
- Webhook message deduplication extracted into a dedicated helper with regression coverage for issue #68 (#70)

### Security
- Resolved the `path-to-regexp` audit alert in the Express dependency tree (#70)

## [0.2.1] - 2026-03-26

### Fixed
- Chronological ordering in group context windows (#66)
- Cursor update to only advance after successful C4 delivery (#66)
- onSuccess callback in retry-success branch to ensure cursor advances (#66)

## [0.2.0] - 2026-03-23

### Added
- WebSocket long connection support via `transport: "websocket"` config (default)
- Configurable API domain via `domain: "feishu" | "lark"` config
- Richer `/health` endpoint with domain, transport, connection state, and uptime

### Changed
- Pinned `@larksuiteoapi/node-sdk` to 1.59.0
- Added PM2 `kill_timeout: 5000` for graceful WebSocket shutdown
- `verification_token` only required in webhook mode

### Known Issues
- SDK node-sdk#177: WSClient timer leak on excessive reConnect calls. Mitigated by relying solely on autoReconnect (never calling reConnect externally) + PM2 process-level recovery.

## [0.1.11] - 2026-03-17

### Added
- Voice message transcription support via optional voice-asr skill (#61)
  - DM: all voice messages processed when voice-asr is installed; graceful "not supported" reply when not installed
  - Group (smart mode): only when @mentioned; group (allowed mode): all voice messages
  - Loading reaction shown during transcription; removed on completion
  - Transcription via `~/zylos/bin/transcribe`; voice messages forwarded as `[Voice] <text>`
  - Temp audio files cleaned up after transcription

### Fixed
- Audio download API: use `type=file` instead of `type=audio` (the latter returned error 234001) (#61)

## [0.1.10] - 2026-03-08

### Added
- Extract text from interactive card messages (#58)
  - Support Schema 2.0 cards (body.elements with markdown, div, plain_text, column_set)
  - Support legacy/API-transformed format (flattened 2D array with text, lark_md tags)
  - Filter whitespace-only content from API-transformed Schema 2.0 cards
  - Fall back to card title (both top-level and header.title.content paths)
  - Applied to webhook messages, quoted message resolution, and group context

## [0.1.9] - 2026-03-02

### Security
- Bump axios 1.13.4 → 1.13.6 (high: DoS via `__proto__` in mergeConfig) (#53)
- Bump qs 6.14.1 → 6.14.2 (low: arrayLimit bypass in comma parsing) (#53)

### Changed
- Add release process guidelines to CLAUDE.md (#54)

## [0.1.8] - 2026-03-02

### Changed
- Use stdin form for c4-send examples in SKILL.md (#51)

## [0.1.7] - 2026-02-26

### Added
- DM policy model: `dmPolicy` (open/allowlist/owner) with `dmAllowFrom` list, replacing legacy whitelist
- On-demand media download script (`scripts/download.js`) for image/file retrieval by resource key
- Markdown card rendering for outgoing messages (`message.useMarkdownCard` in config.json, default: true)
- Auto-detects markdown content (code blocks, headers, bold, lists, tables) and sends as interactive card
- Falls back to plain text if card sending fails
- DM rejection message for non-allowed users
- Group rejection messages for unauthorized @mentions and disabled group policy

### Changed
- Legacy whitelist config auto-migrated to dmPolicy on upgrade (post-upgrade hook)
- Legacy admin commands (`list-whitelist`, `add-whitelist`, etc.) aliased to new dmPolicy commands
- `useMarkdownCard` defaults to true on install and upgrade

## [0.1.6] - 2026-02-20

### Added
- Split log files by thread for audit trail isolation

### Fixed
- Bind webhook server to 127.0.0.1 (security: prevent direct port exposure)
- Path traversal protection in log paths and media downloads
- Config watcher: null filename handling, directory-based watcher, reload timer cleanup
- Admin CLI: complete validation and policy enum alignment
- Guard against malformed webhook event payloads
- Sanitize image key in download path and guard JSON.parse
- Sanitize typing marker paths and wrap log writes in try/catch
- Ensure DATA_DIR exists before token write
- Persist internal token to file for cross-process-tree access
- Reject-reply fallback checks result instead of relying on .catch()
- readSheetData delegates to values API with proper URL encoding
- Chat pagination and URL encoding fixes

### Security
- Standards audit: 19 fixes covering input validation, ID normalization, lazy-load guards

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
