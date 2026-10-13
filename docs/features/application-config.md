# 应用配置：JSON 与环境的独立职责

状态：已实现启动校验和严格分工。JSON 管应用行为、Agent 运行参数及非敏感工具设置；环境变量 / `.env` 管部署启动参数和凭据。**同一字段不同时支持两种配置来源，不用环境变量覆盖 JSON。**当前不提供配置管理 UI 或热重载。

## 文件与职责

后端默认使用 `~/.piko`。进程变量 `PIKO_HOME` 可指定绝对路径，用于发现自己的配置目录；不从 JSON 或该目录 `.env` 定位自己。

```text
PIKO_HOME/config/
  piko.json       # 通道行为与工具开关，不含监听地址、路径或凭据
  settings.json   # 模型预设、思考、压缩、重试与流参数
  models.json     # 模型目录、能力、非敏感请求参数与环境变量名绑定
  .env            # 可选：部署参数、API Key、Token；权限 0600
```

首次初始化只创建缺失 JSON 与工作区模板，不把生效的环境值写回 JSON，不创建 auth.json，不覆盖已有文件。模型配置详见 [Durable 配置](durable-runtime.md)。

## JSON：行为和非敏感设置

`piko.json` 可省略字段，按应用默认行为补齐；使用严格 schema，未知字段和错误类型拒绝启动。

```json
{
  "channels": {
    "telegram": {
      "enabled": false,
      "userId": "填写自己的数字用户 ID"
    }
  },
  "tools": {
    "web_search": { "enabled": true },
    "web_extract": { "enabled": true }
  }
}
```

- Telegram 默认关闭；enabled 和允许访问的 userId 仅由 JSON 管理。有 Token 不自动启用通道。
- 两个网络工具默认启用。关闭时从主/子 Agent 的实际工具表移除；即使有搜索 Key，也不会反向启用被关闭的工具。正常运行时工具清单不列出已禁用工具。
- settings.json 中的 profiles/defaultProfile、compaction、retry、stream 仅属于 JSON；没有对应环境覆盖入口。当前选择另保存在 Durable Agent 文档中，默认预设不覆盖已有选择。
- models.json 的 headersEnv 只绑定 HTTP header 到一个环境变量**名称**，不放 header 值；API Key 字段不在 JSON schema 中。地址、能力、请求默认值等非敏感设置仍在 JSON，不要把凭据塞进 URL 或其他文字字段。

## 环境：部署和凭据

进程环境或私有 `config/.env`：

```dotenv
PIKO_HOST=127.0.0.1
PIKO_PORT=8787
# 可选：工作区绝对路径；默认 PIKO_HOME/workspace
# PIKO_WORKSPACE=/absolute/assistant-workspace
DEEPSEEK_API_KEY="填写自己的模型 API Key"
BRAVE_SEARCH_API_KEY="填写自己的搜索 API Key"
PIKO_TELEGRAM_BOT_TOKEN="填写新的 Bot Token"
```

| 环境变量 | 职责 / 默认值 |
| --- | --- |
| PIKO_HOME | 数据目录，默认 ~/.piko；仅进程 bootstrap，绝对路径 |
| PIKO_WORKSPACE | 工作区部署路径，默认 PIKO_HOME/workspace；绝对路径 |
| PIKO_HOST | 后端监听地址，默认 127.0.0.1 |
| PIKO_PORT | 后端监听端口，默认 8787；整数 1–65535 |
| PIKO_TELEGRAM_BOT_TOKEN | Telegram 敏感凭据；仅 JSON enabled=true 时需要 |
| BRAVE_SEARCH_API_KEY | 内置搜索凭据；缺失不阻止启动，工具反馈未配置 |
| DEEPSEEK_API_KEY 等 | 内建供应商按 pi-ai 约定的环境名称解析 |
| CUSTOM_API_KEY 等 | 自定义供应商为 provider ID 转大写并将非字母数字换成下划线，再加 _API_KEY |
| headersEnv 引用的变量 | HTTP header 值，仅在后端解析，不进入工具 schema |
| PIKO_OAUTH_<规范化供应商 ID> | 已有 OAuth 凭据的序列化值；仅放私有 .env，刷新后原子写回；详见 Durable 配置 |

只有环境体系内部存在 `config/.env < 进程环境` 的优先级：未设置保留本地值，显式空值覆盖本地值。此规则不影响 JSON 行为。可使用引号、export 前缀与行尾注释；读取不修改全局 process.env，不把后端值注入 Expo。可变 OAuth 凭据不允许陈旧的进程 override，以保证刷新后重启仍使用新值。

后续新增 API Key、Token、加密密钥同样只接环境读取；当前尚无需要用户配置的加密密钥或加密存储功能。

## 放错位置就报错

- piko.json 中的 http、workspace、botToken、工具 apiKey 均拒绝；不支持字面值，也不支持 `env:NAME` 作为绕过入口。正确的环境值不能覆盖并掩盖这些非法 JSON。
- 环境中的 PIKO_TELEGRAM_ENABLED、PIKO_TELEGRAM_USER_ID、PIKO_WEB_SEARCH_ENABLED、PIKO_WEB_EXTRACT_ENABLED 拒绝，提示对应 JSON 字段；不默默忽略旧变量。
- models.json 中的 apiKey 和 header 值字段 headers 不再接受；改用环境 API Key 与只含名称的 headersEnv。
- 非空 auth.json 不再是凭据来源，会提示先移出凭据；没有 fallback，不允许它与环境两边同时配置。初始化不创建该文件，不自动删除用户旧文件。

JSON 语法/结构、放错位置、HTTP 或路径错误会拒绝启动；错误只报告文件、字段或变量名称，不打印其值。结构合法但已启用的 TG 缺 Token 或 userId 无效时，仅禁用 TG 并给出警告，RN 和其他工具继续可用。关闭 TG 时不校验其凭据。

## 修改、部署与安全

配置在后端启动/创建 Harness 时读取，修改后重启；不会重读并替换进行中的模型请求。指导和技能的刷新规则不同，见 [生效时机](durable-runtime.md#更新的生效时机)。已有主会话的 cwd 不能随便换路径，恢复原路径或使用新 PIKO_HOME；state 固定在 home/state，必须在工作区之外。

升级现有部署时，先把监听地址/端口/路径从 JSON 移到环境，把启用开关/允许用户从环境移到 JSON，再把 auth.json 的模型 API Key 移入环境并删除旧凭据文件；不要直接用旧格式重启。停止后备份整个私有目录，备份仍含敏感资料，不提交或公开。

凭据不进入源码、Git、镜像、前端 EXPO_PUBLIC_* 或助手提示；私有 .env 保持 0600，运行账号独立控制访问。JSON 与 env 的分工、cwd 或工具来源分类都不是沙箱。Piko 没有自身登录验证/Origin 白名单，公开部署仍需反向代理认证覆盖页面、API、SSE，并限制绕过代理直连；见 [Linux 部署](linux-deployment.md)。
