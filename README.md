# Piko

[中文](README.zh-CN.md) | English

**A little more room for everyday life. Powered by Pi Durable.**

Piko is a local-first personal assistant. Through an ongoing conversation, it helps you think, organize work, and keep useful results in your own workspace.

## Features

- **Chat**: A persistent main conversation and independent side chats, with streaming replies, attachments, and optional Telegram private chat.
- **Tasks**: Delegate background work or create tasks that run manually, once, or on a schedule.
- **Posts**: Generate personalized reading based on your context, automatically or on demand.
- **Artifacts**: Browse and download finished work saved by the assistant.
- **Workspace and tools**: Files, memory, skills, web search and extraction, and configurable MCP tools.

## Development

The frontend uses Expo / React Native and the backend uses Bun. The agent runtime is powered by pi-durable, with model access through pi-ai. With Bun 1.4+ and Node.js installed, run from the repository root:

```bash
bun install --frozen-lockfile
bun install --cwd apps/mobile --frozen-lockfile
bun run dev:web
```

The development command starts the API at `127.0.0.1:8787` and Expo Web at `localhost:8081`. On first launch, Piko initializes its configuration and workspace under `~/.piko`; [configure a model](docs/guides/configuration.md) before sending messages.

```bash
bun run typecheck
bun run build:web
```

See the [documentation index](docs/README.en.md) for deployment, configuration, and backups.

## Status and security

Piko is under active development; features and data formats may change. iOS and Android have not been comprehensively tested on devices, and there are no published mobile releases.

**The API has no authentication, file and shell tools use the backend account's permissions, and the workspace is not a sandbox.** The server listens on localhost by default; do not expose it directly to untrusted networks. For remote access, protect the Web UI, API, and SSE with an authenticated proxy and prevent direct backend access.

Configuration, conversation data, attachments, and the default workspace live under `~/.piko`. Keep credentials private and [back up your data](docs/guides/storage.md).

## License

[MIT](LICENSE)
