# Durable 配置与运行时

状态：服务端已接入 pi-durable / pi-ai 1.1.0，配套 chord 同为 1.1.0，使用 Piko 原有 HTTP/SSE 和 UI。无需 Pi CLI，不读取 `~/.pi/agent`。TG 已提供模型/思考强度按钮与压缩命令；RN 配置管理界面尚未实现，可编辑 JSON 并调用控制 API。Durable Extension 仅由 Piko 源码注册，不加载用户提供的插件代码。

1.1.0 的原生任务记录提供 startedAt/endedAt，工具结果和模型回复提供 durationMs；Piko 的工具进度与耗时展示尚未接入。此次升级继续使用原生 JSONL 存储，保留重启中断后不自动重跑的语义。

## 实时事件与历史

实时监听使用 durable 的 `watchEvents(harness, conversationId, context)`，替代直接解析 `subscribeCommits` / `pi.live`。Pi 适配器把 `message_start/update/end` 转成 Piko 的独立 message 更新，包含消息身份、完整文字、提交标记与临时身份替换关系；SDK 类型与事件只留在 `server/runtime/`。RN 和 TG 按助手消息更新展示，不累计整轮回答。

初始 snapshot 和事件积压超过原生缓冲上限后收到的 snapshot 都参与校正。原生 snapshot 的 entries 只表示当前有效上下文，不能作为 UI 全量历史；Piko 从完整 JSONL entries 补齐已完成回复和消息边界，并把投影限制到该 snapshot 的 entry 水位，随后继续消费后续事件，避免重复或提前展示后来提交的消息。输入使用原生 submission 独立结算；会话快照从原生事务读取历史与状态，不再维护 Piko Run 终态。原生已保存的失败尝试仍遵循原有历史投影规则，不因 retry 事件自行删除。

会话关闭时停止事件订阅；订阅异常会报告并阻止该会话继续接纳新生成，避免静默丢失实时输出。工具、思考、压缩和 usage 事件已有原生来源，但本次只消费消息与提交状态，不新增这些内容的产品展示，不另建永久事件存储。`watchEvents` 的实验性协议通过运行时适配器隔离，后续升级依赖时需验证事件映射和 snapshot 行为。

## 首次配置

启动前指定新的测试数据目录（已存在旧版状态时尤其如此）：

```powershell
$env:PIKO_HOME = Join-Path $env:USERPROFILE ".piko-durable-test"
bun run dev
```

首次启动补齐 config、state 和 workspace，只创建缺失文件。未配置模型时仍能打开 API、查看主会话和配置元数据，发送消息会提示配置模型。旧状态不会自动迁移或删除。

敏感凭据只放后端环境或私有 config/.env，JSON 不接受 API Key/Token，auth.json 已退出凭据读取。DeepSeek 示例：

```dotenv
DEEPSEEK_API_KEY="填写你的 DeepSeek API Key"
```

环境与 JSON 不提供同一字段的双入口；分工和旧部署调整见 [应用配置](application-config.md)。

模型预设统一放在 config/piko.json 的 agent 下，不再生成/读取 settings.json：

```json
{
  "version": 1,
  "agent": {
    "defaultProfile": "quick",
    "profiles": {
      "quick": {
        "provider": "deepseek",
        "model": "deepseek-flash",
        "thinking": "off"
      },
      "careful": {
        "provider": "deepseek",
        "model": "deepseek-flash",
        "thinking": "high"
      }
    }
  }
}
```

上述 ID 来自锁定的 pi-ai 1.1.0 内建目录。DeepSeek 无需额外定义供应商，`config/models.json` 保持 `{"providers":{}}` 即可。实际可用模型以 GET /api/runtime 返回为准：目录中存在模型也须有可用凭据。

第一次创建原生会话使用 agent.defaultProfile；未设置时选第一个可用模型。已有会话的选择保存在原生日志，重启会保留。修改 defaultProfile 后若需切换当前会话，再调用 selection API。最初没有模型的会话在重启后可以启用新配置。

通用思考值为 off/minimal/low/medium/high/xhigh/max；只接受所选模型实际支持的值，能力列表见 thinkingLevels。例如本版本 deepseek-flash 支持 off/low/high/max。Piko 不把所有思考值强行映射到每个供应商。

直接切换 provider/model 且省略 thinking 时，通过 pi-ai 的 clampThinkingLevel 保留或调整当前思考强度；显式指定 thinking 仍严格验证，不支持的值拒绝。预设省略 thinking 时使用 off。TG `/models` 与 `/thinking` 针对同一个原生选择，交互和状态字段见 [通道说明](telegram-channel.md#模型思考强度与管理命令)。

## 自定义供应商与参数

models.json 支持内建供应商覆盖和自定义模型，只存元数据与非敏感请求默认值。API Key 只能从环境解析；自定义供应商示例：

```json
{
  "providers": {
    "custom": {
      "api": "openai-completions",
      "baseUrl": "https://your-endpoint.example/v1",
      "request": { "temperature": 0.2, "maxTokens": 4096 },
      "compat": {
        "supportsStore": false,
        "supportsReasoningEffort": true,
        "maxTokensField": "max_tokens"
      },
      "models": [
        {
          "id": "your-model-id",
          "name": "My model",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 8192,
          "samplingParams": { "top_p": 0.9 }
        }
      ]
    }
  }
}
```

在后端环境或 .env 设置 CUSTOM_API_KEY，在 piko.json 的 agent.profiles 选择 custom/对应模型。自定义供应商的变量名是规范化大写 provider ID 加 _API_KEY；模型地址、token 上限、reasoning 和 compat 要符合实际服务。

- 自定义 API 支持 openai-completions、openai-responses、anthropic-messages。其他 pi-ai 内建供应商继续使用其原生适配器；不声称 JSON 能注册任意 API 实现。
- 模型 maxTokens 是能力上限，request.maxTokens 是本次请求的默认输出预算；request.temperature 是采样默认值。模型级 request 可覆盖供应商级。
- 支持 name、api、baseUrl、reasoning、input、cost、contextWindow、maxTokens、thinkingLevelMap、samplingParams、headersEnv、compat 和 request；modelOverrides 按 ID 覆盖内建模型。
- JSON 不支持 apiKey 或 header 值字段 headers。headersEnv 只存变量名称，例如 `{"Authorization":"CUSTOM_AUTH_HEADER"}`；实际完整 header 值只放环境，不支持字面值或 env: 前缀的混合解析。keyless 仍是 JSON 中的非敏感行为，用于无鉴权本机服务。
- 可选 config/.env 与进程环境只管理部署/敏感字段，进程值优先；JSON 行为没有环境覆盖入口，不修改进程全局环境。Expo 的客户端环境独立设置；改动后重启生效。
- 已有 OAuth 凭据改为私有 .env 的 PIKO_OAUTH_<规范化供应商 ID> 序列化值，由 EnvironmentCredentialStore 配合 pi-ai 刷新、0600 原子写回并同步同一后端的存储读者，不写凭据 JSON。可变 OAuth 不接受进程环境 override，防止重启用到旧 refresh token；Piko 仍没有交互登录/授权页面。
- JSON 使用严格校验，未知字段报错，不静默忽略。解析错误仅报告文件/字段，不把凭据值放进错误响应。

Piko 不再暴露 compaction/retry 配置，不在 Harness 启动时覆盖这两项；直接使用 Durable 默认策略。当前锁定版本默认启用自动压缩和重试（最多额外 3 次），不是删除功能。agent.stream 仍可选配 transport/timeoutMs/maxRetries/maxRetryDelayMs/cacheRetention；这是模型供应商连接选项，不是 Harness 生成重试策略，客户端聊天仍使用 Piko SSE。

## 控制 API

以下操作针对主会话，API 默认端口 8787：

```powershell
# 只返回配置元数据与能力，不返回 API Key
Invoke-RestMethod http://127.0.0.1:8787/api/runtime

# 选择预设
Invoke-RestMethod http://127.0.0.1:8787/api/runtime/selection -Method Post `
  -ContentType "application/json" -Body '{"profile":"careful"}'

# 也可直接选 provider/model，或仅修改思考强度
Invoke-RestMethod http://127.0.0.1:8787/api/runtime/selection -Method Post `
  -ContentType "application/json" -Body '{"thinking":"high"}'

# 手动压缩会使用当前模型生成摘要，保留完整聊天历史
Invoke-RestMethod http://127.0.0.1:8787/api/runtime/compact -Method Post

# 停止当前回复或手动压缩
Invoke-RestMethod http://127.0.0.1:8787/api/runtime/cancel -Method Post
```

selection 也接受 `{"provider":"deepseek","model":"deepseek-flash","thinking":"off"}`。选择和压缩不能与生成并发，繁忙返回 409。piko/models JSON 与凭据环境修改后重启后端生效。指导和技能在每次模型请求自动刷新。

## 更新的生效时机

当前锁定 durable 1.1.0。压缩使用原生 `Conversation.compact(instructions, context)`，返回摘要任务的 TaskId；Piko 等待 `Harness.waitForTask`，再等待结果 submission 落入会话。TG `/compact` 不传额外压缩要求，摘要由当前模型生成。压缩改变模型上下文，完整原生 entries 仍用于聊天历史展示；自动压缩沿用 Durable 默认策略，Piko 不再提供自动压缩开关；手动 compact 保留。

运行时及 HTTP 现在明确返回 `status: compacted | skipped | cancelled`；skipped 的 reason 为 no_summary 或 stale。只有摘要实际应用后才报告 compacted；未生成摘要、摘要过时无法应用、取消分别反馈，任务失败、丢失结果或其他应用错误报告失败。TG `/compact` 同步这些结果，可选模型详情读取失败不影响已确认的结果。后台自动压缩是否需要展示提醒仍待设计。

普通 RN/TG 输入使用 `whenBusy: "steer"`，Harness 固定 `steeringMode: "all"`；原生 inbox 在工具轮结束或最终回复边界一次接纳所有待应用 steers。多条输入分别去重，助手输出独立监听并按原生消息分条；不提供 follow-up 输入模式，模型/思考选择等管理操作仍要求空闲。

目前不提供 `/reload` 命令或 HTTP 接口。模型配置与凭据修改后重启后端生效；Piko 内建 Durable Extension 随服务端代码部署。重启保留原生历史与当前模型/思考选择，不会因为 defaultProfile 改变而覆盖已有选择。

| 修改内容 | 当前生效方式 |
| --- | --- |
| 工作区 AGENTS.md、MEMORY.md | 每次模型请求前重新读取；同一轮调用工具后的下一次模型请求也会读取，无需重启 |
| 应用内建 server/resources/prompts/core.md | 每次模型请求重新读取；loader 代码变化需重启 |
| 工作区 .agents/skills、内建技能的新增/删除及 SKILL.md 索引字段 | 每次模型请求重新发现；查询技能也读取当前目录，无需重启 |
| SKILL.md 正文、技能脚本及辅助文件 | read 或执行时读取；已进入旧消息的正文需重新读取，运行中的脚本不被替换 |
| config/piko.json、models.json | 重启后端；默认预设不自动切换已有会话 |
| config/.env 中的 OAuth 凭据 | 手工修改需重启；运行时 OAuth 刷新由串行原子写入发布新凭据 |
| config/.env、PIKO_HOME 及进程环境 | 重启后端；外部终端新设置不会注入已有进程 |
| Piko 服务端代码、运行时适配器及依赖升级 | 重启或部署；开发模式 bun --watch 负责重启 |
| 工作区其他 md、JSONL 和 Durable 原生文档 | 普通文件按需读取，重启保留存储和文档状态 |
| 内建 templates/AGENTS.md、templates/MEMORY.md | 初始化只补齐缺失文件，已有工作区定制不覆盖 |

通过 `/models`、`/thinking` 或 selection API 改变当前选择时，直接调用原生 `Conversation.configure`，不重读配置文件，无需重启。编辑 piko/models JSON 或凭据 .env 后先重启，再选择；编辑工作区指导、记忆和技能后继续对话即可。

`AGENTS.md` 指助手工作区中的文件；源码仓库根目录的 AGENTS.md 只指导仓库开发，运行时不自动继承。其他任意 md 也不会自动变成系统提示。资源刷新在下一次模型请求生效，不会修改正在流式生成的那次请求。

## 技能与指导

工作区 `.agents/skills/<name>/SKILL.md` 使用 YAML frontmatter：

```markdown
---
name: project-notes
description: Record decisions and next actions for an ongoing project.
---

Read the project's existing notes, then append the new decision and next action.
```

技能来源为工作区 `.agents/skills` 与应用内建；同名时工作区版本优先。`PIKO_HOME/skills` 不创建也不读取。不递归读取祖先指导、不加载个人 Pi CLI 资源。`disable-model-invocation: true` 的技能不注入模型索引；普通技能只注入名称/描述/文件路径，正文由 read 按需加载。聊天输入不会展开 CLI `/skill:` 命令。

Piko 应用内建 core.md 提供运行规则；工作区只使用 AGENTS.md（如何表达和做事）与 MEMORY.md（长期事实与结论）。工作区指导与技能可由用户或助手修改，初始化不会覆盖。具体职责见 [资源与工具](workspace-and-main-chat.md#资源与工具)。

## 内建 Durable Extension

Piko 在服务端源码中用 Durable Extension 注册资源 section、网络工具与子 Agent 能力。用户工作区和 `PIKO_HOME` 不提供可加载的代码插件入口；`/api/runtime` 只报告 Piko 内建工具及其配置状态。用户要补充工作流程与领域知识时使用工作区 skill，不能借此注册新的运行时工具。内建网络工具的行为见 [内置网络工具](web-tools.md)。

Durable task、doc 与 extension API 仍由 Piko 内部实现使用；用户发起的自定义后台代码任务或第三方扩展安装目前不属于产品能力。定时任务复用普通子 Agent 回传，详见 [定时任务](scheduled-work-items.md)。主会话另有内部 记忆整理 Durable task：闲置 30 分钟后检查增量，并创建仅配 `read/write/edit` 的专用子 Agent 直接编辑每日和长期 Markdown 文件；一次整理中可能有多个模型/工具轮次。游标、活动 整理 task 与重试状态由 Durable 文档保存，不增加任务/UI、SQL 或独立历史副本；只由后台闲置调度触发，不提供手动触发工具。细节见 [工作区与主会话模型](workspace-and-main-chat.md#每日与长期记忆整理)。

## 边界

read/write/edit/bash 使用本机权限，工作区是默认目录而非沙箱。原生 read 1.1.0 仍拒绝图片，未另写替代工具；模型 imageInput 仅表示模型能力。Tasks 任务展示、结果时间线和内部记忆整理已接入；附件、RN 配置管理、工具轨迹和全局产物管理尚未接入。

验证使用 faux provider 和本机 HTTP 模型服务，无真实付费请求。类型检查覆盖 API 与移动端，自动化覆盖 JSON 请求参数、配置校验、Durable 原生文档、内建工具、历史压缩、重启去重与记忆整理 的游标、四工具范围、直接双文件编辑和中断后按原范围重试；程序不提供文件回滚或哈希冲突保护，真机后台与真实长对话仍需使用验证。

## 后台子 Agent

主 Agent 的 subagent 工具通过同一个 Harness 创建持久化 owned 子会话，基本工具、内建扩展、全局指导和技能共用，移除委派与任务管理工具；任务执行额外使用本任务目录与记忆。模型/思考选择同步已有子会话，当前已准备请求继续使用原选择；主会话空闲限制不因独立子任务运行而拒绝。重启同步当前配置，取消不确定执行，仅恢复已完成结果的回传阶段。详见 [后台子 Agent](background-subagents.md)。
