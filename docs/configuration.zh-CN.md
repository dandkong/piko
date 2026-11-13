# 配置

[English](configuration.md) | 中文

首次启动时 Piko 会补齐 `~/.piko/config/` 中缺失的文件。启动前设置绝对路径 `PIKO_HOME` 可使用其他数据目录。不要提交凭据，也不要将凭据放进客户端。

- `piko.json`：应用行为和模型角色选择。
- `models.json`：模型目录、自定义供应商及可选模型 API Key。
- `auth.json`：模型凭据，优先于 `models.json` 中的模型 Key。
- `.env`：可选的后端部署参数、工具和通道凭据；设置为私有权限（`chmod 600`）。

例如，在 `auth.json` 中为内置模型配置凭据：

```json
{
  "deepseek": { "type": "api_key", "key": "YOUR_API_KEY" }
}
```

在 App 设置或 Telegram `/models` 中选择已配置模型。Piko 不从环境变量读取模型凭据。

## 自定义模型供应商

例如，在 `models.json` 添加兼容 OpenAI 的供应商和模型（地址与模型参数需替换成供应商的实际值）：

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

在 `auth.json` 中使用同一个供应商 ID：`{ "custom": { "type": "api_key", "key": "YOUR_API_KEY" } }`。也可在 `models.json` 的供应商中填写 `apiKey`；`auth.json` 优先。配置采用严格校验，不要把 Key 放进 URL 或前端环境变量。

## 可选 Telegram

通过 BotFather 创建机器人并获取自己的 Telegram 数字用户 ID。在 `piko.json` 中将 `channels.telegram.enabled` 设为 `true`，将 `channels.telegram.userId` 设为数字 ID 字符串；在私有 `config/.env` 或进程环境中设置 `PIKO_TELEGRAM_BOT_TOKEN`。仅配置 Token 不会启用 Telegram。机器人与 App 共用主会话。

## 可选网页工具

网页搜索和提取默认启用；按需在私有 `config/.env` 或进程环境设置 `BRAVE_SEARCH_API_KEY`、`EXA_API_KEY`、`TAVILY_API_KEY`、`DEEPSEEK_SEARCH_API_KEY` 和 `FIRECRAWL_API_KEY`。这些 Key 与模型凭据分开。搜索只使用已配置的供应商；没有任何 Key 时会报告未配置。工具开关和搜索供应商顺序在 `piko.json` 中设置。

全部字段和供应商专属选项见[详细配置说明](operations/configuration.md)及[模型运行时说明](operations/agent-runtime.md)。

工具凭据及部署参数在后端启动时读取，修改后停止前台进程并重新启动。App 模型选择在下一次安全接纳边界生效。

**安全：**API 没有身份认证。助手可用后端账户权限执行命令和访问文件，不要将服务直接暴露给不可信网络。
