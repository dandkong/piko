# Configuration

English | [中文](configuration.zh-CN.md)

Piko initializes `~/.piko/config/` on first launch. `PIKO_HOME` selects another absolute data directory; set it before starting the backend. Never commit credentials or expose them to the client.

- `piko.json`: application behavior and model role selection.
- `models.json`: model catalog, custom providers and optional model API keys.
- `auth.json`: model credentials; takes precedence over model keys in `models.json`.
- `.env`: optional backend deployment settings and tool/channel credentials. Keep it private (`chmod 600`).

For a built-in model, add its credential to `auth.json`, for example:

```json
{
  "deepseek": { "type": "api_key", "key": "YOUR_API_KEY" }
}
```

Choose a configured model in the app's settings or Telegram `/models`. Piko does not read model credentials from environment variables. For custom providers, tool keys, or Telegram configuration, see the detailed [Chinese configuration reference](operations/configuration.md) and [model runtime reference](operations/agent-runtime.md).

Tool credentials and deployment settings are read when the backend starts. Stop the foreground process, make changes, then start it again. App model selection takes effect at the next safe admission boundary.

**Security:** the API has no authentication. The assistant can run commands and access files with the backend account's permissions. Do not expose the service directly to untrusted networks.
