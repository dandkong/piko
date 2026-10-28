# Durable 配置与运行时

状态：服务端使用 pi-durable / pi-ai / chord 1.4.0，通过 Piko HTTP/SSE 与 UI 提供交互。无需 Pi CLI，不读取 `~/.pi/agent`。TG 提供模型/思考强度按钮与压缩命令；RN 设置只支持全局主模型、后台模型和思考强度。其他模型供应商、目录、凭据、工具、通道及环境变量由部署配置管理。模型设置 API 尚未鉴权，仅提供角色选择读写。Durable Extension 仅由 Piko 源码注册，不加载用户提供的插件代码。

原生任务记录提供 startedAt/endedAt，工具结果和模型回复提供 durationMs；Piko 的工具进度与耗时展示尚未接入。当前使用 Durable 原生 SQLite 存储；普通不确定执行在重启时不自动重跑，已完成子任务的报告与可恢复重试阶段会继续执行。存储位置和升级影响见[SQLite 存储](storage.md)。

## 实时事件与历史

实时监听使用 durable 的 `watchEvents(harness, conversationId, context)`。Pi 适配器把 `message_start/update/end` 转成 Piko 的独立 message 更新，包含消息身份、完整文字、提交标记与临时身份替换关系；SDK 类型与事件只留在 `server/runtime/`。RN 和 TG 按助手消息更新展示，不累计整轮回答。

初始 snapshot 和事件积压超过原生缓冲上限后收到的 snapshot 都参与校正。原生 snapshot 的 entries 只表示当前有效上下文，不能作为 UI 全量历史；Piko 从完整原生 entries 补齐已完成回复和消息边界，并把投影限制到该 snapshot 的 entry 水位，随后继续消费后续事件，避免重复或提前展示后来提交的消息。输入使用原生 submission 独立结算；会话快照从原生事务读取历史与状态，执行终态由 Durable 原生记录提供。原生已保存的失败尝试遵循历史投影规则，不因 retry 事件自行删除。

会话关闭时停止事件订阅；订阅异常会报告并阻止该会话继续接纳新生成，避免静默丢失实时输出。工具、思考、压缩和 usage 事件由 Durable 提供；当前客户端只展示消息与提交状态，不另建永久事件存储。`watchEvents` 协议通过运行时适配器隔离，升级依赖时需要验证事件映射和 snapshot 行为。

## 首次配置

本地验证时可指定独立的数据目录，避免与日常使用数据混用：

```powershell
$env:PIKO_HOME = Join-Path $env:USERPROFILE ".piko-durable-test"
bun run dev
```

首次启动补齐 config、state 和 workspace，只创建缺失文件。未配置模型时仍能打开 API、查看主会话和配置元数据，发送消息会提示配置模型。旧格式数据不导入；详见[存储说明](storage.md)。

模型凭据只认 config/auth.json 与 config/models.json 的 `providers.<id>.apiKey`，不读环境变量；部署参数、通道与工具凭据仍在后端环境或私有 config/.env：

```dotenv
EXA_API_KEY="可选：Exa Search Key"
TAVILY_API_KEY="可选：Tavily Search Key"
DEEPSEEK_SEARCH_API_KEY="可选：DeepSeek Search Key"
BRAVE_SEARCH_API_KEY="可选：Brave Search Key"
```

环境与 JSON 不提供同一字段的双入口；配置职责见[应用配置](configuration.md)。

模型预设放在 config/piko.json 的 agent 下；运行时不读取 settings.json：

```json
{
  "version": 1,
  "agent": {
    "profiles": {
      "main": {
        "provider": "deepseek",
        "model": "deepseek-flash",
        "thinking": "off"
      },
      "background": {
        "provider": "custom",
        "model": "your-background-model",
        "thinking": "off"
      }
    }
  }
}
```

`agent.profiles` 只有 `main` 和 `background` 两个固定角色位，不接其他名字，写错即启动报错：`main` 是统一主聊与所有旁聊的全局模型，不是新会话默认值；`background` 供之后新建的委派、任务执行和记忆整理子会话使用。未单独配置 `background` 时动态跟随 `main`；后台思考强度可单独覆盖；省略 `main` 时不会自动选目录首个模型，执行前要求明确配置。后台供应商缺凭据只让该次后台任务失败并报错，不会阻止后端启动。主聊和旁聊的 Durable AgentDoc 在服务启动及下一轮接纳时对齐全局主模型；正在运行的一轮保持原模型。后台 AgentDoc 及专门构建的子 Agent 仍保持各自选择。

上述 ID 来自锁定的 pi-ai 1.4.0 内建目录。DeepSeek 无需额外定义供应商，`config/models.json` 保持 `{"providers":{}}` 即可。实际可用模型以 TG `/models` 列表为准：目录中存在模型也须有可用凭据。

主模型由设置页或 TG `/models` 统一修改，并写回 `agent.profiles.main`。App 与 Telegram 共用同一选择；新一轮执行前主聊和旁聊会对齐该配置，重启也会重新对齐。AgentDoc 保存实际执行模型，不再提供前台会话级粘性选择。首次未配置时不会自动挑目录首个模型。

通用思考值为 off/minimal/low/medium/high/xhigh/max；只接受所选模型实际支持的值，能力列表见 thinkingLevels。例如本版本 deepseek-flash 支持 off/low/high/max。Piko 不把所有思考值强行映射到每个供应商。

直接切换 provider/model 且省略 thinking 时，通过 pi-ai 的 clampThinkingLevel 保留或调整当前思考强度；显式指定 thinking 仍严格验证，不支持的值拒绝。预设省略 thinking 时使用 off。TG `/models` 与 `/thinking` 针对同一个原生选择，交互和状态字段见[通道说明](../features/telegram-channel.md#命令与菜单)。

## 自定义供应商与参数

models.json 支持内建供应商覆盖和自定义模型，可保存 provider apiKey，或使用优先级更高的 auth.json；不从环境变量回退模型 API Key。自定义供应商示例：

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

把凭据写进 config/models.json 的 providers.custom.apiKey 或 config/auth.json，模型定义写在 providers.custom.models；模型地址、token 上限、reasoning 和 compat 要符合实际服务。模型凭据不读环境变量。

- 自定义 API 支持 openai-completions、openai-responses、anthropic-messages。其他 pi-ai 内建供应商继续使用其原生适配器；不声称 JSON 能注册任意 API 实现。
- 模型 maxTokens 是能力上限，request.maxTokens 是本次请求的默认输出预算；request.temperature 是采样默认值。模型级 request 可覆盖供应商级。
- 支持 name、api、baseUrl、reasoning、input、cost、contextWindow、maxTokens、thinkingLevelMap、samplingParams、headersEnv、compat 和 request；modelOverrides 按 ID 覆盖内建模型。
- 供应商凭据写 `providers.<id>.apiKey`（与 Pi 格式一致）或放进 auth.json；模型级 apiKey 与 header 值字段 headers 仍不接受。headersEnv 只存变量名称，例如 `{"Authorization":"CUSTOM_AUTH_HEADER"}`；实际完整 header 值只放环境，不支持字面值或 env: 前缀的混合解析。keyless 仍是 JSON 中的非敏感行为，用于无鉴权本机服务，且与 apiKey 互斥。
- 可选 config/.env 与进程环境只管理部署/敏感字段，进程值优先；JSON 行为没有环境覆盖入口，不修改进程全局环境。Expo 的客户端环境独立设置；改动后重启生效。
- auth.json 兼容 Pi 的 `type: "oauth"` 条目，但 Piko 只读不写，刷新与登录仍由 Pi 负责；Piko 仍没有交互登录/授权页面。
- JSON 使用严格校验，未知字段报错，不静默忽略。解析错误仅报告文件/字段，不把凭据值放进错误响应。

Piko 不提供 compaction/retry 配置，Harness 使用 Durable 默认策略。当前锁定版本默认启用自动压缩和重试（最多额外 3 次）。agent.stream 可选配 transport/timeoutMs/maxRetries/maxRetryDelayMs/cacheRetention；这是模型供应商连接选项，不是 Harness 生成重试策略，客户端聊天仍使用 Piko SSE。

## 会话控制

主模型/思考修改由 TG `/models`、`/thinking` 和 App 设置页共用配置服务；忙碌会话在当前轮结束后对齐。手动压缩仍要求会话空闲并占用维护边界。App 与 TG 的停止仍共用会话控制器，App 使用 `POST /api/chat/stop`，TG 使用 `/stop`。

HTTP 不提供独立 runtime 管理入口或聊天提交回执查询路由。模型目录、描述、配置、压缩和原生 submission 查询能力供内部运行时、TG、接纳去重和后台报告使用。客户端通过 POST 回执、最新快照和相同 requestId 重试确认接纳。

主/后台模型角色选择热应用；piko.json 中其他应用行为、models.json 模型目录、auth.json 模型 Key 和后端环境由部署管理，按部署方式重启生效。App 设置不编辑供应商、目录或凭据；工具、通道及技能脚本环境同样由部署管理。指导和技能在每次模型请求自动刷新。

## 更新的生效时机

当前使用 durable 1.4.0。压缩使用原生 `Conversation.compact(instructions, context)`，返回摘要任务的 TaskId；Piko 等待 `Harness.waitForTask` 结束，不检查摘要是否新增或等待结果 submission 落入会话。TG `/compact` 不传额外压缩要求，摘要由当前模型生成。压缩改变模型上下文，完整原生 entries 仍用于聊天历史展示；自动压缩使用 Durable 默认策略，手动 compact 由 Piko 提供。

运行时内部返回 `status: compacted | cancelled`，任务失败报告错误。`compacted` 表示原生压缩任务完成，不额外断言摘要是否新增或已经应用；摘要和 submission 由 Durable 管理。TG 的 `/compact` 负责接纳，开始和完成通过原生生命周期观察呈现，并提供取消/失败提示；主会话的阈值/溢出自动压缩也通知本进程已验证的 TG 私聊。通知不阻塞事件观察；各会话快照附带活动压缩状态。旁聊和后台子会话不向主聊天 TG 通知；生命周期只用于呈现，不写聊天正文或可靠 outbox。

普通 RN/TG 输入使用 `whenBusy: "steer"`，Harness 固定 `steeringMode: "all"`；原生 inbox 在工具轮结束或最终回复边界一次接纳所有待应用 steers。多条输入分别去重，助手输出独立监听并按原生消息分条；不提供 follow-up 输入模式。主模型变更不修改忙碌会话 AgentDoc，下一轮接纳时应用。

主/后台模型选择无需重启，在安全接纳边界生效；模型目录、凭据和其他部署配置通过部署流程变更并按需重启。Piko 内建 Durable Extension 随服务端代码部署。重启保留原生历史与当前模型/思考选择，不会因为 agent.profiles.main 改变而覆盖已有选择。

| 修改内容 | 当前生效方式 |
| --- | --- |
| 工作区 AGENTS.md、MEMORY.md | 每次模型请求前重新读取；同一轮调用工具后的下一次模型请求也会读取，无需重启 |
| 应用内建 server/resources/prompts/core.md | 每次模型请求重新读取；loader 代码变化需重启 |
| 工作区 .agents/skills、内建技能的新增/删除及 SKILL.md 索引字段 | 每次模型请求重新发现；查询技能也读取当前目录，无需重启 |
| SKILL.md 正文、技能脚本及辅助文件 | read 或执行时读取；已进入旧消息的正文需重新读取，运行中的脚本不被替换 |
| 设置页修改 profiles.main / profiles.background | 主/后台策略立即发布；前台会话在空闲或下一轮边界对齐，后台新建工作采用最新选择，已有工作不切换 |
| models.json、auth.json 模型目录与凭据 | 由部署管理；按部署方式重启服务 |
| config/.env、PIKO_HOME 及进程环境 | 重启后端；外部终端新设置不会注入已有进程 |
| Piko 服务端代码、运行时适配器及依赖升级 | 重启或部署；开发模式 bun --watch 负责重启 |
| 工作区其他 md、JSONL 和 Durable 原生文档 | 普通文件按需读取，重启保留存储和文档状态 |
| 内建 templates/AGENTS.md、templates/MEMORY.md | 初始化只补齐缺失文件，已有工作区定制不覆盖 |

TG `/models`、`/thinking` 与 App 设置页共用配置服务，修改全局主模型并在空闲/下一轮边界对齐主聊与旁聊；不会覆盖正在运行的回复。后台新建工作默认动态跟随主模型，思考强度可单独覆盖，显式选择后台模型后独立生效。已启动工作不切换。模型目录、凭据和技能脚本环境由部署管理；工作区指导、记忆和技能仍在下一次模型请求刷新。

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

技能只发现工作区 `.agents/skills/<目录>/SKILL.md` 与内建 `skills/<目录>/SKILL.md` 的单层目录，不递归、不跟随链接目录或链接技能文件；同名时工作区版本优先。`PIKO_HOME/skills` 不创建也不读取。不递归读取祖先指导、不加载个人 Pi CLI 资源。`disable-model-invocation: true` 的技能不注入模型索引；普通技能只注入名称/描述/文件路径，正文由 read 按需加载。聊天输入不会展开 CLI `/skill:` 命令。

Piko 应用内建 core.md 提供运行规则；工作区只使用 AGENTS.md（如何表达和做事）与 MEMORY.md（长期事实与结论）。工作区指导与技能可由用户或助手修改，初始化不会覆盖。具体职责见[资源与工具](../features/workspace-and-main-chat.md#资源与工具)。

## 内建 Durable Extension

Piko 在服务端源码中用 Durable Extension 注册资源 section、网络工具与子 Agent 能力。用户工作区和 `PIKO_HOME` 不提供可加载的代码插件入口；内建工具与配置状态由内部运行时描述提供给 TG，不另设 HTTP 管理入口。用户要补充工作流程与领域知识时使用工作区 skill，不能借此注册新的运行时工具。内建网络工具的行为见[内置网络工具](../features/web-tools.md)。

Durable task、doc 与 extension API 仍由 Piko 内部实现使用；用户发起的自定义后台代码任务或第三方扩展安装目前不属于产品能力。保存任务的执行复用普通后台工作回传，详见[任务与执行记录](../features/tasks.md)。主会话另有内部记忆整理 Durable task：闲置 30 分钟后检查增量，并创建仅配 `read/write/edit` 的专用子 Agent 直接编辑每日和长期 Markdown 文件；一次整理中可能有多个模型/工具轮次。游标、活动整理 task 与重试状态由 Durable 文档保存，不增加任务/UI、SQL 或独立历史副本；只由后台闲置调度触发，不提供手动触发工具。细节见[工作区与主会话模型](../features/workspace-and-main-chat.md#每日与长期记忆整理)。

## 边界

read/write/edit/bash 使用本机权限，工作区是默认目录而非沙箱。原生 read 返回图片块，图片由 Photon 处理器缩放/转码；非视觉模型接收占位诊断，附件存储见[附件与图片读取](../features/attachments.md)。Tasks 任务展示、结果时间线、内部记忆整理和全局产物浏览/下载/确认删除已接入；RN 设置只支持模型角色选择，不管理 Key、工具、通道或环境变量；任务执行产物聚合尚未接入。

类型检查覆盖 API 与移动端；程序不提供文件回滚或哈希冲突保护，真机后台与真实长对话仍需使用验证。

## 后台子 Agent

主 Agent 的 `subagent_*` 系列工具通过同一个 Harness 创建持久化 owned 子会话，默认提供基本工具和技能索引，不自动注入全局 core、AGENTS.md 或 MEMORY.md，移除委派与任务管理工具；任务执行由 Tasks 层组装本任务目录、记忆和固定 Prompt。Agent 构建与资源选择不依赖 Reporter，模型、cwd、指令和工具由原生 AgentDoc 保存，自动资源策略单独保存文件/技能选择。已有子会话重启保留这些选择；新建子会话解析当前后台默认模型。主会话空闲限制不因独立子任务运行而拒绝。重启取消不确定执行，仅恢复已完成结果的回传阶段。详见[后台工作说明](../features/background-subagents.md)与[Agent 构建](../features/agent-composition.md)。
