# Run Piko from source

English | [中文](deployment.zh-CN.md)

Piko is an early development project. This guide covers manual source-based operation, not a production deployment or a native app release.

## Requirements

- Bun 1.4 or later and Node.js for Expo CLI.
- A working shell for the assistant's file and command tools.
- A model provider and credentials; see [Configuration](configuration.md).

## Development Web

From the repository root:

```bash
bun install --frozen-lockfile
bun install --cwd apps/mobile --frozen-lockfile
bun run dev:web
```

Expo Web is available at `http://localhost:8081`; the API listens on `0.0.0.0:8787` by default. First launch initializes missing files under `~/.piko`. Configure and select a model before sending a message.

## Source-built Web

```bash
bun run build:web
bun run start
```

Open `http://127.0.0.1:8787`. Stop the foreground process with Ctrl+C. The backend serves the existing Web export; rebuild it after frontend changes. Do not run another backend against the same state directory.

## Security

The backend requires a single-user access key and checks browser origins. Shell and file tools run with the backend user's permissions, and the workspace is not a sandbox. The default bind covers all IPv4 interfaces; use `PIKO_HOST=127.0.0.1` to restrict it to loopback. Use HTTPS or a trusted network for remote access. See [configuration](configuration.md) and [storage and backups](storage.md).

Android and iOS builds and devices are not comprehensively tested. No Docker deployment or installable releases are currently provided.
