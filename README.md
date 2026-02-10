# zylos-lark

[![Version](https://img.shields.io/badge/version-0.1.0--beta.11-blue.svg)](https://github.com/zylos-ai/zylos-lark/releases)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Lark/Feishu communication channel for [Zylos Agent](https://github.com/zylos-ai/zylos-core), enabling bidirectional messaging between users and Claude via Lark.

## Features

- **Private Messaging** - Secure one-on-one communication with Claude
- **Group Chat Support** - Respond to @mentions in groups
- **Smart Groups** - Monitor all messages from designated groups
- **Owner Auto-binding** - First user to interact becomes the admin
- **User Whitelist** - Control who can access the bot
- **Media Support** - Send and receive images and files
- **Group Context** - Include recent messages when responding to @mentions

## Getting Started

Tell your Zylos agent:

> "Install the lark component"

Zylos will guide you through the setup process, including configuring your Lark app credentials.

Once installed, simply message your bot on Lark. The first user to interact becomes the owner (admin).

## Managing the Bot

Just tell your Zylos agent what you need:

| Task | Example |
|------|---------|
| Add user to whitelist | "Add user xxx to lark whitelist" |
| Enable smart group | "Make this group a smart group" |
| Check status | "Show lark bot status" |
| Restart bot | "Restart lark bot" |

## Group Chat Behavior

| Scenario | Bot Response |
|----------|--------------|
| Private chat from owner/whitelisted | Responds via Claude |
| Smart group message | Receives all messages |
| @mention in allowed group | Responds via Claude (with context) |
| Owner @mention in any group | Responds via Claude |
| Unknown user | Ignored |

## Troubleshooting

Just ask Zylos:

> "Check lark status"

> "Show lark logs"

> "Restart lark"

## Documentation

- [SKILL.md](./SKILL.md) - Component specification
- [CHANGELOG.md](./CHANGELOG.md) - Version history

## Contributing

1. Fork the repository
2. Create a feature branch
3. Submit a Pull Request

## License

[MIT](./LICENSE)

---

Made with Claude by [Zylos AI](https://github.com/zylos-ai)
