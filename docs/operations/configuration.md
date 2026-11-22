# 应用配置

Piko 将应用行为、模型配置和部署凭据分开管理；设置页只提供主/后台模型和思考强度，不编辑供应商、凭据或工具。首次配置步骤见[用户指南](../guides/configuration.zh-CN.md)。

## 文件与职责

`PIKO_HOME` 由进程环境指定绝对路径，默认 `~/.piko`；不能由该目录内的配置定位自身。

```text
PIKO_HOME/config/
  piko.json     # 应用行为、Agent 角色、通道和内建工具
  mcp.json      # MCP Server 和工具暴露方式
  models.json   # 模型目录、能力、请求参数和可选供应商 apiKey
  auth.json     # Pi 格式模型凭据，优先于 models.json
  .env          # 部署参数、通道及工具凭据，建议权限 0600
```

初始化只创建缺失配置和工作区模板，不覆盖用户内容；`auth.json` 由使用方提供。模型凭据只从 `auth.json` 或 `models.json` 读取，不回退环境变量。私有 `.env` 与进程环境合并时，进程环境优先；不影响 JSON 行为配置。

## JSON：行为和非敏感设置

`piko.json` 使用严格 schema，错误字段或类型拒绝启动；未指定主模型时不自动选择目录首项：

```json
{
  "version": 1,
  "agent": {
    "profiles": {
      "main": { "provider": "deepseek", "model": "deepseek-flash", "thinking": "off" }
    }
  },
  "channels": { "telegram": { "enabled": false } },
  "tools": {
    "web_search": { "enabled": true, "providers": ["brave", "exa", "tavily", "deepseek"] },
    "web_extract": { "enabled": true }
  }
}
```

后台角色未配置时动态跟随主模型；Telegram 默认关闭，启用时须设置数字 `userId`。搜索后端按配置顺序选择有凭据的供应商。MCP 单独配置，见 [MCP 工具](../features/mcp.md)。

模型供应商可在 `models.json` 使用 `providers.<id>.apiKey` 或通过 `auth.json` 提供凭据；`keyless` 与 apiKey 互斥。`headersEnv` 保存 header 对应的环境变量名，不保存值；不要把凭据放在 URL 中。模型字段和示例见[Agent 运行时](agent-runtime.md)。

## 环境：部署和凭据

| 环境变量 | 作用 |
| --- | --- |
| `PIKO_HOME` | 数据根目录，仅从进程环境读取 |
| `PIKO_WORKSPACE` | 工作区绝对路径；默认 PIKO_HOME/workspace |
| `PIKO_HOST` / `PIKO_PORT` | 后端监听地址，默认 `0.0.0.0:8787`；设为 `127.0.0.1` 可仅监听本机 |
| `PIKO_ACCESS_KEY` | 必需的单用户访问密钥；修改后重启使所有登录失效 |
| `PIKO_PUBLIC_ORIGIN` | 反向代理提供的公开 Web 地址，例如 `https://piko.example.com`；用于允许来源及安全 Cookie |
| `PIKO_ALLOWED_ORIGINS` / `PIKO_ALLOWED_HOSTS` | 额外允许的浏览器来源 / Host，逗号分隔；仅在开发或特殊部署时配置 |
| `PIKO_TELEGRAM_BOT_TOKEN` | 已启用 Telegram 的 Bot Token |
| `BRAVE_SEARCH_API_KEY`、`EXA_API_KEY`、`TAVILY_API_KEY`、`DEEPSEEK_API_KEY`、`FIRECRAWL_API_KEY` | 可选网络工具凭据 |
| `headersEnv` 或 MCP 配置引用的变量 | 对应服务使用的后端凭据 |

配置示例见[用户指南](../guides/configuration.zh-CN.md)及[网络工具](../features/web-tools.md)。Shell 和 stdio MCP 子进程可能继承后端环境，包括敏感凭据；不要将凭据输出到聊天、日志或不可信程序。

## 修改、部署与安全

主/后台模型选择在安全边界热应用；模型目录、凭据、工具、通道及部署环境变更后重启。指导和技能刷新规则见[运行时生效时机](agent-runtime.md#更新的生效时机)。

API 使用访问密钥保护；远程使用时 HTTP 不加密凭据或内容，应使用 HTTPS 或受信网络。配置、凭据及完整备份应按敏感数据保护；详见[部署说明](deployment.md)和[存储说明](storage.md)。
