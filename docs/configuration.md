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

Web search and extraction are enabled by default. Add provider keys to private `config/.env` or the process environment as needed: `BRAVE_SEARCH_API_KEY`, `EXA_API_KEY`, `TAVILY_API_KEY`, `DEEPSEEK_SEARCH_API_KEY`, and `FIRECRAWL_API_KEY`. These keys are separate from model credentials. Search only uses configured providers; without any keys it reports that search is not configured. Configure tool behavior and search provider order in `piko.json`.

For the complete set of fields and provider-specific options, see the detailed [Chinese configuration reference](operations/configuration.md) and [model runtime reference](operations/agent-runtime.md).

Tool credentials and deployment settings are read when the backend starts. Stop the foreground process, make changes, then start it again. App model selection takes effect at the next safe admission boundary.

**Security:** the API has no authentication. The assistant can run commands and access files with the backend account's permissions. Do not expose the service directly to untrusted networks.
