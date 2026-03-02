# CLAUDE.md

Development guidelines for zylos-lark.

## Project Conventions

- **ESM only** — Use `import`/`export`, never `require()`. All files use ES Modules (`"type": "module"` in package.json)
- **Node.js 20+** — Minimum runtime version
- **Conventional commits** — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- **No `files` in package.json** — Rely on `.gitignore` to exclude unnecessary files. Use `.npmignore` if publishing to npm
- **Secrets in `.env` only** — Never commit secrets. Use `~/zylos/.env` for credentials, `config.json` for non-sensitive runtime config
- **English for code** — Comments, commit messages, PR descriptions, and documentation in English

## Release Process

When releasing a new version, **all four files** must be updated in the same commit:

1. **`package.json`** — Bump `version` field
2. **`package-lock.json`** — Run `npm install` after bumping package.json to sync the lock file
3. **`SKILL.md`** — Update `version` in YAML frontmatter to match package.json
4. **`CHANGELOG.md`** — Add new version entry following [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format

Version bump commit message: `chore: bump version to X.Y.Z`

After merge, create a GitHub Release with tag `vX.Y.Z` from the merge commit.

## Architecture

This is a **communication component** for the Zylos agent ecosystem.

- `src/index.js` — Main entry point (Express webhook server)
- `src/cli.js` — Lark API CLI tool (documents, spreadsheets, calendar, contacts)
- `src/admin.js` — Admin CLI (config, groups, whitelist management)
- `src/lib/config.js` — Config loader with hot-reload
- `src/lib/client.js` — Lark API authentication client
- `src/lib/message.js` — Message send/receive, file upload/download
- `src/lib/document.js` — Document and spreadsheet operations
- `src/lib/calendar.js` — Calendar event queries
- `src/lib/chat.js` — Group management
- `src/lib/contact.js` — Contact queries
- `scripts/send.js` — C4 outbound message interface
- `hooks/` — Lifecycle hooks (post-install, pre-upgrade, post-upgrade)
- `ecosystem.config.cjs` — PM2 service config (CommonJS required by PM2)

See [DESIGN.md](./DESIGN.md) for full architecture documentation.
