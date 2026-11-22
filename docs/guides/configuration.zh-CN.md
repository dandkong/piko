# 配置

[English](configuration.md) | 中文

首次启动时 Piko 会补齐 `~/.piko/config/` 中缺失的文件。启动前设置绝对路径 `PIKO_HOME` 可使用其他数据目录。不要提交凭据，也不要将凭据放进客户端。

- `piko.json`：应用行为和模型角色选择。
- `mcp.json`：可选 MCP Server 配置，详见 [MCP 工具](../features/mcp.md)。
- `models.json`：模型目录、自定义供应商及可选模型 API Key。
- `auth.json`：模型凭据，优先于 `models.json` 中的模型 Key。
- `.env`：必需的访问密钥及可选的后端部署参数、工具和通道凭据；设置为私有权限（`chmod 600`）。

启动前在 `.env` 设置足够长的随机 `PIKO_ACCESS_KEY`；Web 和原生 App 使用它登录。修改密钥并重启后，已有登录失效。

例如，在 `auth.json` 中为内置模型配置凭据：

```json
{
  "deepseek": { "type": "api_key", "key": "YOUR_API_KEY" }
}
```

在 App 设置或 Telegram `/models` 中选择已配置模型。Piko 不从环境变量读取模型凭据。

## 应用行为与模型角色

`piko.json` 采用版本 `1` 和严格 schema，未知字段或错误类型会被拒绝。以下示例展示主要字段；模型 ID 和 Telegram 用户 ID 应替换为实际值，示例中 Telegram 保持关闭：

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

`agent.profiles.main` 统一主聊和所有旁聊；可选的 `background` 默认动态跟随主模型，其思考强度可独立覆盖。切换模型不改变正在运行的工作；未配置 `main` 时不会自动选择模型。App 只编辑角色与思考强度，不管理供应商目录或凭据。

搜索供应商列表须非空、无重复且使用已知名称。搜索按顺序尝试有凭据且支持该查询的供应商，仅上游失败时回退；空结果视为成功。关闭网页工具时，该工具从 Agent 工具集中移除。

## 部署环境

启动前在进程环境设置绝对路径 `PIKO_HOME`；默认值为 `~/.piko`。其他部署参数及工具/通道凭据可放在进程环境或私有 `PIKO_HOME/config/.env`：

| 变量 | 用途 |
| --- | --- |
| `PIKO_WORKSPACE` | 可选绝对工作区路径，默认 `PIKO_HOME/workspace`。 |
| `PIKO_HOST`、`PIKO_PORT` | 监听地址和端口，默认 `0.0.0.0`、`8787`。 |
| `PIKO_TELEGRAM_BOT_TOKEN` | Telegram 启用时需要的 Bot 凭据。 |
| `BRAVE_SEARCH_API_KEY`、`EXA_API_KEY`、`TAVILY_API_KEY`、`DEEPSEEK_API_KEY` | 搜索凭据；Exa 和 DeepSeek 的 Key 也用于对应提取服务。 |
| `FIRECRAWL_API_KEY` | 启用 Firecrawl 网页提取。 |

进程环境优先于 `config/.env`，显式空值也会覆盖；Shell 工具可读取合并后的全部环境，包括敏感凭据，不要将值输出到聊天或日志，也不要传给不可信程序。环境变量不覆盖 JSON 行为或提供模型凭据。部署参数、目录、凭据及工具/通道行为修改后须重启；模型角色选择在安全接纳边界生效。

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

网页搜索和提取默认启用；按需在私有 `config/.env` 或进程环境设置 `BRAVE_SEARCH_API_KEY`、`EXA_API_KEY`、`TAVILY_API_KEY`、`DEEPSEEK_API_KEY` 和 `FIRECRAWL_API_KEY`。这些 Key 与模型凭据分开。搜索只使用已配置的供应商；没有任何 Key 时会报告未配置。工具开关和搜索供应商顺序在 `piko.json` 中设置。

全部字段和供应商专属选项见[详细配置说明](../operations/configuration.md)及[模型运行时说明](../operations/agent-runtime.md)。

工具凭据及部署参数在后端启动时读取，修改后停止前台进程并重新启动。App 模型选择在下一次安全接纳边界生效。

**安全：**API 使用单用户访问密钥。HTTP 不加密凭据和内容；助手可用后端账户权限执行命令和访问文件，工作区不是沙箱。
