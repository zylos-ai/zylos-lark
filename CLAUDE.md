# CLAUDE.md

Development guidelines for zylos-lark.

## Project Conventions

- **ESM only** — Use `import`/`export`, never `require()`. All files use ES Modules (`"type": "module"` in package.json)
- **Node.js 20+** — Minimum runtime version
- **Conventional commits** — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- **No `files` in package.json** — Rely on `.gitignore` to exclude unnecessary files. Use `.npmignore` if publishing to npm
- **Secrets in `.env` only** — Never commit secrets. Use `~/zylos/.env` for credentials, `config.json` for non-sensitive runtime config
- **English for code** — Comments, commit messages, PR descriptions, and documentation in English

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
