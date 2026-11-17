# Piko

[中文](README.zh-CN.md) | English

A local-first personal assistant powered by Pi Durable. Piko provides a shared conversation across a Web app and an optional Telegram bot, with background work, scheduled tasks, posts, and a workspace for files, memory, and skills.

> [!WARNING]
> Piko is an early development project, not a secure public service. Its API has no authentication, and shell and file tools run with the backend account's permissions. The workspace is **not a sandbox**. The server listens on localhost by default; do not expose it to untrusted networks. If remote access is needed, protect the Web UI, API, and SSE with an authenticated proxy and prevent direct access to the backend.

## Run from source

Requirements: Bun 1.4+ and Node.js for Expo. From the repository root:

```bash
bun install --frozen-lockfile
bun install --cwd apps/mobile --frozen-lockfile
bun run dev:web
```

The development command starts the API on `127.0.0.1:8787` and Expo Web on `localhost:8081`. On first launch Piko initializes its private configuration and workspace under `~/.piko`. Configure a model before sending messages; see [configuration](docs/guides/configuration.md).

For a source-built Web bundle served by the Bun backend, see the [source deployment guide](docs/guides/deployment.md). Telegram is optional; it shares the main conversation with the app.

```bash
bun run typecheck
bun run build:web
```

## Status and scope

Current capabilities include persistent main and side chats, background delegation and scheduled tasks; an assistant workspace with files, memory and skills; optional Telegram; scheduled or manual posts; and artifact browsing. Web chat supports attachment uploads, assistant-sent files and playback previews for supported audio.

Not yet implemented: post notifications, task-artifact aggregation, native attachment selection, login and multi-user isolation, permissions or a sandbox, push notifications, and browser automation. See the [roadmap](ROADMAP.en.md) for details.

Piko is under active development. There are no published Android or iOS releases, container deployment, or production support guarantees. Native clients and devices have not been comprehensively tested. The current automated test coverage is limited. Features, configuration, and storage may change.

The backend stores configuration, Durable SQLite state, attachments and the assistant workspace under `~/.piko` by default. `PIKO_HOME` and `PIKO_WORKSPACE` can change these paths. Keep credentials private and back up the complete state and workspace; see [storage](docs/guides/storage.md).

The app interface supports English, Chinese, and following the device language. This preference is local to the device and does not translate user content, server messages, or Telegram.

Browse the [documentation index](docs/README.en.md) for English and Chinese user guides. Detailed product, architecture and design references are maintained in Chinese.

## License

Piko is licensed under the [MIT License](LICENSE). Third-party artwork and adapted code notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
