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

Choose a configured model in the app's settings or Telegram `/models`. Piko does not read model credentials from environment variables.

## Application behavior and model roles

`piko.json` has version `1` and uses a strict schema; unknown fields or incorrect types are rejected. The following example shows the main behavior fields. Replace model IDs and the Telegram user ID with your own values; the example leaves Telegram disabled.

```json
{
  "version": 1,
  "agent": {
    "profiles": {
      "main": { "provider": "deepseek", "model": "deepseek-flash", "thinking": "off" }
    }
  },
  "channels": { "telegram": { "enabled": false, "userId": "YOUR_NUMERIC_USER_ID" } },
  "tools": {
    "web_search": { "enabled": true, "providers": ["brave", "exa", "tavily", "deepseek"] },
    "web_extract": { "enabled": true }
  }
}
```

`agent.profiles.main` is shared by the main chat and all side chats. The optional `background` role defaults to following `main` dynamically; its thinking level can be overridden independently. Switching models does not change work already running. No model is chosen automatically if `main` is absent. The app edits these roles and thinking levels, not the provider catalog or credentials.

The search provider order must be nonempty, contain no duplicates, and use known provider names. Search tries configured providers with credentials in order, falling back on upstream errors; an empty result is successful and does not trigger a fallback. Disabling a web tool removes it from the agent's tool set.

## Deployment environment

Set `PIKO_HOME` in the process environment before startup; it is the absolute data directory and defaults to `~/.piko`. Other deployment settings and tool/channel credentials can be placed in the process environment or private `PIKO_HOME/config/.env`:

| Variable | Purpose |
| --- | --- |
| `PIKO_WORKSPACE` | Optional absolute workspace path; defaults to `PIKO_HOME/workspace`. |
| `PIKO_HOST`, `PIKO_PORT` | Bind address and port; defaults are `127.0.0.1` and `8787`. |
| `PIKO_TELEGRAM_BOT_TOKEN` | Bot credential, required when Telegram is enabled. |
| `BRAVE_SEARCH_API_KEY`, `EXA_API_KEY`, `TAVILY_API_KEY`, `DEEPSEEK_API_KEY` | Search credentials; Exa and DeepSeek keys also enable their respective extraction providers. |
| `FIRECRAWL_API_KEY` | Enables the Firecrawl extraction provider. |

Process environment values override `config/.env`, including explicit empty values. Shell tools receive the merged environment, including credentials; do not print values in chat or logs, or pass them to untrusted programs. Environment variables do not override JSON behavior or supply model credentials. Changes to deployment settings, catalog, credentials and tool/channel behavior require restarting the backend; model role choices apply at a safe admission boundary.

## Custom model provider

For an OpenAI-compatible endpoint, add a provider and its models to `models.json` (replace the example endpoint and model metadata with your provider's values):

```json
{
  "providers": {
    "custom": {
      "api": "openai-completions",
      "baseUrl": "https://your-endpoint.example/v1",
      "models": [{
        "id": "your-model-id",
        "name": "My model",
        "reasoning": false,
        "input": ["text"],
        "contextWindow": 128000,
        "maxTokens": 4096
      }]
    }
  }
}
```

Use the same provider ID in `auth.json`: `{ "custom": { "type": "api_key", "key": "YOUR_API_KEY" } }`. You can instead put `apiKey` on the provider in `models.json`; `auth.json` takes precedence. The configuration is strictly validated. Do not place API keys in URLs or expose them in frontend environment variables.

## Optional Telegram

Create a bot with BotFather and obtain your numeric Telegram user ID. In `piko.json`, set `channels.telegram.enabled` to `true` and `channels.telegram.userId` to your numeric ID as a string. Put `PIKO_TELEGRAM_BOT_TOKEN` in the private `config/.env` or process environment. A token alone does not enable Telegram. The bot uses the same main conversation as the app.

## Optional web tools

Web search and extraction are enabled by default. Add provider keys to private `config/.env` or the process environment as needed: `BRAVE_SEARCH_API_KEY`, `EXA_API_KEY`, `TAVILY_API_KEY`, `DEEPSEEK_API_KEY`, and `FIRECRAWL_API_KEY`. These keys are separate from model credentials. Search only uses configured providers; without any keys it reports that search is not configured. Configure tool behavior and search provider order in `piko.json`.

For provider-specific request options, `headersEnv`, keyless providers, OAuth entries and the full schema, see the detailed [configuration reference](../operations/configuration.md) and [model runtime reference](../operations/agent-runtime.md) (Chinese). `headersEnv` contains environment variable names, never header values; do not place credentials in URLs or frontend builds.

Tool credentials and deployment settings are read when the backend starts. Stop the foreground process, make changes, then start it again. App model selection takes effect at the next safe admission boundary.

**Security:** the API has no authentication. The assistant can run commands and access files with the backend account's permissions. Do not expose the service directly to untrusted networks.
