# 应用配置：JSON 与环境的独立职责

状态：已实现启动校验和严格分工。JSON 管应用行为、Agent 运行参数、模型目录与模型凭据（models.json / auth.json）；环境变量 / `.env` 只管部署启动参数、通道与工具凭据。**模型凭据不读环境变量**；同一字段不同时支持两种配置来源。当前不提供配置管理 UI 或热重载。

## 文件与职责

后端默认使用 `~/.piko`。进程变量 `PIKO_HOME` 可指定绝对路径，用于发现自己的配置目录；不从 JSON 或该目录 `.env` 定位自己。

```text
PIKO_HOME/config/
  piko.json       # 统一 Agent 预设/连接选项、通道与工具行为，不含部署参数/凭据
  models.json     # 模型目录、能力、请求参数与供应商 apiKey
  auth.json       # 模型凭据，Pi 格式；优先级高于 models.json；权限 0600
  .env            # 可选：部署参数、通道/工具凭据；权限 0600
```

首次初始化只创建缺失 JSON 与工作区模板，不把生效的环境值写回 JSON，不创建 settings.json，不覆盖已有文件；auth.json 由使用方按 Pi 格式提供。模型配置详见 [Durable 配置](durable-runtime.md)。

## JSON：行为和非敏感设置

piko.json 格式 version 为 1，可省略行为字段并按默认值补齐；agent.profiles 默认空，不替安装用户指定供应商。使用严格 schema，未知字段和错误类型拒绝启动。

```json
{
  "version": 1,
  "agent": {
    "profiles": {
      "main": { "provider": "deepseek", "model": "deepseek-flash", "thinking": "off" },
      "background": { "provider": "deepseek", "model": "deepseek-flash", "thinking": "off" }
    }
  },
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
- 模型预设固定为 agent.profiles.main（主会话初始选择）和 agent.profiles.background（委派、定时任务、记忆整理等后台子 Agent），不接受其他名字，两者模型与思考级别启动时校验；可选 agent.stream 保留模型连接参数，没有环境覆盖入口。主会话当前选择另保存在 Durable Agent 文档中，profiles.main 不覆盖已有选择；省略 background 时后台继承主会话，省略 main 时新会话选第一个可用模型。
- 不再配置 retry/compaction，Piko 不覆盖 Durable 的默认策略；当前锁定依赖默认启用重试（最多额外 3 次）与自动压缩，SDK 升级时跟随其默认行为。
- models.json 的 headersEnv 只绑定 HTTP header 到一个环境变量**名称**，不放 header 值。供应商凭据写 `providers.<id>.apiKey`（内联，格式与 Pi 一致），或放在 auth.json；`keyless` 与 `apiKey` 互斥，两者都不配置时供应商视为未配置。地址、能力、请求默认值等非敏感设置仍在 JSON，不要把凭据塞进 URL 或其他文字字段。

## 环境：部署和凭据

进程环境或私有 `config/.env`：

```dotenv
PIKO_HOST=127.0.0.1
PIKO_PORT=8787
# 可选：工作区绝对路径；默认 PIKO_HOME/workspace
# PIKO_WORKSPACE=/absolute/assistant-workspace
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
| headersEnv 引用的变量 | HTTP header 值，仅在后端解析，不进入工具 schema |

只有环境体系内部存在 `config/.env < 进程环境` 的优先级：未设置保留本地值，显式空值覆盖本地值。此规则不影响 JSON 行为。可使用引号、export 前缀与行尾注释；读取不修改全局 process.env，不把后端值注入 Expo。**模型供应商凭据不读环境变量**：只认 auth.json 与 models.json。

部署参数、通道与工具凭据继续只接环境读取；模型供应商凭据只认 auth.json 与 models.json。当前尚无需要用户配置的加密密钥或加密存储功能。

## 放错位置就报错

- piko.json 中的 http、workspace、botToken、工具 apiKey 均拒绝；不支持字面值，也不支持 `env:NAME` 作为绕过入口。正确的环境值不能覆盖并掩盖这些非法 JSON。
- 行为开关和授权用户只从 piko.json 读取；同名环境变量不会覆盖 JSON，也不会参与配置。
- 模型凭据按 Pi 的优先级解析：auth.json 的 `api_key` 条目优先，其次 models.json 的 `providers.<id>.apiKey`；两者都没有时供应商视为未配置，不回退环境变量。
- auth.json 使用 Pi 格式 `{ "<provider>": { "type": "api_key", "key": "…" } }`，也接受 `type: "oauth"` 条目；Piko 只读该文件，OAuth 刷新仍由 Pi 负责。
- models.json 只在 `providers.<id>.apiKey` 接受凭据值，模型级 apiKey 与 header 值字段 headers 仍不接受；header 值走只含名称的 headersEnv。
- settings.json 不是配置来源，不生成也不读取；模型预设只从 piko.json.agent 读取。
- 根级或 agent 下的 retry/compaction 不属于 Piko 配置；Durable 使用自己的默认策略。

JSON 语法/结构、放错位置、HTTP 或路径错误会拒绝启动；错误只报告文件、字段或变量名称，不打印其值。已启用的 TG 缺 Token 或 userId 无效时同样拒绝启动，不自动禁用通道来掩盖配置错误。关闭 TG 时不校验其凭据。

## 修改、部署与安全

配置在后端启动/创建 Harness 时读取，修改后重启；不会重读并替换进行中的模型请求。指导和技能的刷新规则不同，见 [生效时机](durable-runtime.md#更新的生效时机)。已有主会话的 cwd 不能随便换路径，恢复原路径或使用新 PIKO_HOME；state 固定在 home/state，必须在工作区之外。

部署时按当前文件格式配置 piko.json、models.json、auth.json 与私有 .env。旧 settings.json 不参与启动；需要旧配置内容时，手动将有效值写入当前格式。停止后备份整个私有目录，备份仍含敏感资料，不提交或公开。

凭据不进入源码、Git、镜像、前端 EXPO_PUBLIC_* 或助手提示；私有 .env 保持 0600，运行账号独立控制访问。JSON 与 env 的分工、cwd 或工具来源分类都不是沙箱。Piko 没有自身登录验证/Origin 白名单，公开部署仍需反向代理认证覆盖页面、API、SSE，并限制绕过代理直连；见 [Linux 部署](linux-deployment.md)。
