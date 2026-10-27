# RN 与 Telegram 双通道

状态：Telegram 私聊通道已实现，共用原生主会话、提交去重和执行状态；使用 Durable 原生 SQLite，不维护 Piko 自建消息或 Run 表。架构见[架构说明](../ARCHITECTURE.md)。

## 目标与当前范围

RN 提供完整产品体验，Telegram 接入适合私聊的功能，不要求所有功能对齐。两个入口共享工作区、root conversation、历史、当前模型和思考强度；通道各自呈现输入、回复和反馈。

| 能力 | 当前实现 |
| --- | --- |
| 普通文本 | 运行中仍可发送，原生 steer all |
| 回复 | 每条助手消息独立 Rich Markdown，条内流式编辑 |
| 停止与状态 | /stop、/status；可停止 RN/TG 当前工作及手动压缩 |
| 历史与资源 | /recent 最近 10 条已保存消息的单行摘要（角色图标、空白折叠、最多 100 字符）；/skills 浏览技能；/subagent 查看最近 4 个普通后台委派；/task 浏览任务、最近执行和结果 |
| 模型与思考 | /models 供应商/模型按钮，/thinking 当前模型支持的强度 |
| 压缩 | /compact 手动压缩通知开始、完成、取消/失败；threshold/overflow 自动压缩对 TG 静默，聊天历史保留 |
| 帮助 | /start 简短欢迎；/help 按菜单顺序列出命令与作用范围 |
| RN 同步 | 前台持续会话 SSE，接收 TG 输入和回复 |

菜单只在内存保存来源和目录快照，callback 再次鉴权、验证来源和能力。模型选择使用原生 Conversation.configure，选择保存在 Agent 文档；命令和反馈不写成模型消息。管理操作需空闲，普通输入接纳与管理预留共用串行入口；停止不被长时间压缩阻塞。

内建文案为简洁英文，用户内容、模型回复、模型和技能名称保留原文。帮助使用 Piko app 指代 RN 入口。未知命令与不支持媒体给出提示；图片消息（photo 或 image document）下载到共享附件存储，模型通过 `read` 查看；相册仍按每条消息分别处理。连续工具调用聚合在一条临时纯文本消息中；助手文本输出会分隔工具段，同一轮可显示多条临时工具消息，回复投递完成后统一删除；内置 read/write/edit/bash、web_search/web_extract、subagent_*/task_* 按类别显示图标、精简业务名称和参数摘要（如 Delegate work、Archive task），未知动作回退原工具名；工具摘要消息只用于 TG 观察，不写入历史；各端头像状态栏另接收不含参数的实时活动。编辑旧 TG 消息不修改历史、不触发模型。回复 TG 消息时，优先使用 Telegram 提供的引用片段；否则取原消息的 text、caption，或 Rich Message blocks 中的文本，并将其作为 Markdown 引文附在新输入前。Web 端在同一条用户消息中将原文和正文按 Markdown 引用块呈现，不另建消息或添加自定义上下文标记；引文最多 3500 个 Unicode 码点；合并后的整条输入仍受 12,000 字符限制，超出时按普通输入长度校验提示重发，不额外调整引用长度。仅含媒体且没有文本/caption 的引用不注入内容；当前不保存 Telegram 消息 ID 与 Durable 消息 ID 的映射。群聊、语音和后台推送尚未接入。

## 命令与菜单

- `command-format.ts` 统一命令目录与展示格式。Telegram 菜单和 `/help` 顺序固定为 `/status`、`/compact`、`/models`、`/thinking`、`/subagent`、`/task`、`/stop`、`/recent`、`/skills`、`/help`、`/start`。`/subagent` 只读展示 root 主会话拥有的全部普通委派中 ID 最大的最近 4 个；不创建/控制子 Agent，也不展示保存任务执行。列表按钮直接显示真实 ID，点选后原消息编辑为工具同源的最新状态与最近五步，再可返回并刷新最近列表。`/task` 只列出进行中任务，不显示已归档任务，也不提供活跃/归档切换；列表按“截短 UUID · 标题 · 调度时间”显示，任务按钮只显示同一短 ID；短 ID 默认取去掉连字符后的 canonical UUID 前 6 个十六进制字符，冲突时加长，回调仍携带完整 UUID。点任务进入定义/调度/最近执行，详情列出每次执行的短 ID（默认末四位，冲突加长）、状态和时间，执行按钮只显示对应短 ID；点选查看结果，始终编辑同一条消息；只读、不运行/停止/归档任务。两种菜单均以稳定 ID 作为回调身份并在点击时重新读取 Durable 数据。不引入工作区切换、主会话新建/恢复/删除、重载或退出命令。
- `/start` 提供欢迎信息和直接发送请求的说明；`/help` 说明 TG 与 App 共用主会话，模型选择不修改旁聊或后台模型预设。
- `/status` 依次显示模型名称与实际思考强度、上下文用量/上限/百分比、运行状态、技能数和必要的中断/失败提示。压缩状态来自该会话的原生任务，而非 TG 命令局部标记。**不显示工具数量**，不编造队列数或费用；没有用量时明确显示 unknown。
- `/recent` 只取已保存消息，排除流式片段和未应用输入；用户/助手分别用角色图标，每条单行摘要，长文截断不切断 Unicode 字符。完整历史在 App 查看。
- `/skills` 按名称排序，每页最多 6 项；列表按钮打开同一消息中的技能正文详情，可返回并翻页。正文从 `SKILL.md` 的 YAML frontmatter 后读取，最多 3500 个 UTF-16 代码单元且不拆分代理对，超出会明确标注截短；不展示服务端绝对路径，也不执行技能；callback 绑定聊天与消息，目录更新后会重新校验技能。
- `/models` 先显示 `Current: provider/model-name • thinking`，再展示供应商 → 模型（每行 2 个）；目录超过 6 项时分页并显示页码。导航和选择结果更新原消息；选择后保留 Back to providers，再单独提供新模型实际支持的思考菜单。
- `/thinking` 先显示当前选择，再按每行 3 个列出实际支持的强度，当前项标 ✓；不可调整时只说明原因，不提供无效按钮。更改模型或思考强度要求会话空闲。
- Telegram 单行摘要和短详情按 Unicode 码点裁剪，分别最多 100 和 160；技能正文、任务说明和执行结果最多约 3500 个 UTF-16 代码单元，避免拆分代理对，并确保消息不超过 Telegram 单条文本上限。超长文本明确提示截短。`/task` 仅列活动任务，列表超过 6 项时按每页 6 项分页，详情显示最近 5 次执行；列表与执行摘要使用 100 字符档。`/subagent` 只显示最近 4 项、不分页，最近步骤最多 5 条；`/recent` 固定最近 10 条、不分页。
- `/models` 与 `/thinking` 菜单保留来源/消息绑定、15 分钟有效期、菜单快照索引和当前能力复核。`/subagent` 与 `/task` 按钮携带动作和 Durable ID，点击时重新读取 root 事实，因此不依赖内存菜单快照并可跨后端重启继续使用；子工作、任务和执行查询均验证 root 归属。
- 按钮错误使用普通 callback 提示，不弹模态提示框；文案尽量简短。忙碌时稍后重试，菜单过期时重开对应命令。遇到网络/存储不确定性不承诺“没有更改”；设置已确认应用、但菜单更新失败时提示 `/status` 核验，不误报回滚。
- `/compact` 接纳手动压缩；其开始、完成、取消和失败提示由运行时压缩生命周期统一呈现。自动 `threshold` / `overflow` 压缩继续由 Durable 执行，但不发送 TG 生命周期消息。失败不原样转发供应商错误文本。
- 重复 `/compact` 根据实际压缩状态提示已在执行，不启动第二次；压缩期间 `/stop` 保持可用。前台手动压缩可停止，独立后台工作不受普通停止影响。
- 仅 `reason: manual` 的原生压缩任务通知 TG；自动 threshold/overflow 事件静默。手动通知以原生任务结束为准，仅区分完成、取消、失败；不检查是否生成/新增摘要、不等待摘要 submission 应用，也不展示 no_summary/stale 等内部细节。摘要生成与应用由 Durable 管理，通知不阻塞 watchEvents。
- 生命周期提示仅订阅主会话，不接旁聊或后台子会话；只有本次进程中经鉴权的真实 TG 私聊地址才可接收。建立该地址后，主会话的手动压缩会通知，自动压缩保持静默。串行发送保证手动压缩短任务的开始/结束顺序；通知只活在当前进程，不回放历史、不承诺可靠补发。

## 依赖方向与接入位置

RN 经 HTTP/SSE，TG 直接注入同一个 ConversationStore。server/channels/telegram 处理 SDK、身份、命令、轮询和网络呈现；配置由 server/config.ts 加载。ConversationStore 负责临时观察和输出合并；server/runtime 内 DurableChatSession 统一协调输入/管理互斥并缓存尚未挂接的后台回传，原生执行、去重、inbox 与持久状态仍由 Durable 管理，不额外创建 Harness 或数据库。

## 会话、并发与输入去重

TG 使用 telegram:<botId>:<chatId>:<messageId> 作为原生 requestId，不使用可轮换 token。重复已接纳输入返回原提交，不再调用模型或投递回复；不另存哈希或拒绝收据。同 ID 代表同一请求，新内容必须新身份。Telegram update 的游标与确认由 grammY 默认轮询管理，不再与 Durable 接纳成功严格绑定；handler 失败记录脱敏错误并继续处理，不能承诺失败输入一定重投。原生 requestId 去重保留，但不等于端到端无丢失。

运行期间输入进入原生 inbox，在工具轮或最终回复的接纳边界一起应用，不打断已经开始的模型/工具。维护期间立即拒绝普通输入，不把它留到维护后执行；拒绝不产生原生提交。执行失败结算并撤回未应用补充，不自动重跑；停止也撤回未应用输入。未落入原生用户 entries 的撤回输入不进入最终历史。

/stop 身份追加 :stop；原生 piko.stop 文档保存当时 task ID 和结果，重投只操作这些任务，不停止后来的工作。空闲停止也保存空目标。RN 停止使用相同机制的 UUID 请求。连接断开、TG 网络错误和 RN 退后台均不等于停止。

鉴权和来源检查在读历史、创建提交、执行工具或下载前完成；只接纳指定用户普通私聊。启动重启策略见 [工作区与主会话](workspace-and-main-chat.md)。

## 回复呈现与投递

助手回复、命令反馈和菜单直接发送到验证后的私聊，不引用用户消息。用户 messageId 负责输入去重，菜单 messageId 用于编辑和来源校验。

Telegram 通过单一运行时事实订阅持续观察主会话输出；正文、工具与执行边界由同一个串行呈现队列处理，工具开始前冲刷前面的正文，执行结束后再清理临时工具消息。没有独立的工具清空或工具分段事件。每条原生助手消息无论由 App 还是 Telegram 输入触发，都会投递到 TG，并以独立消息流式编辑；保存时以原生 ID 替换临时 ID。App 用户输入不回显到 Telegram，历史消息也不重放；订阅时若有正在进行的实时回复则继续观察。主会话之外的旁聊/子会话原文不直接投递。

- 首条用 sendRichMessage，后续 editMessageText 的 rich_message.markdown；使用 remend 1.3.1 补全未闭合 Markdown、未完成链接仅显示文本，最终发送原正文。渲染修复不改原生历史或 RN 内容。
- 首个未完成的助手文本片段先缓冲 800ms，避免单字触发推送；若回复提前完成则立即发送完整结果。之后流式增量按 800ms 合并，串行发送/编辑并跳过无变化更新；最终完成事件立即刷新，等待模型或工具时续发 typing。连续完成的多条消息仍分别发送，不合并成整轮回复。
- 富文本上限 30,000 UTF-16 单位，普通消息按 Telegram 的 4,096 字符上限分段；不拆开代理对，优先按行拆分，富文本分段修补代码围栏。正文缩短时编辑、删除该条多余段，保留前面回复。
- 只在明确格式拒绝时降级，并按普通上限重新拆分该条；后续保持普通文本。网络、429、认证失败不当作格式问题，每次请求最多 3 次尝试，遵守 retry_after；超过 15 秒冷却报告投递失败。
- 原生失败或停止给出简短普通反馈；帮助、状态和历史查询也使用普通消息，不推送工具原始结果、思考和隐藏指导。
- 发送失败不取消模型、不修改提交成功状态，也不重新运行模型补发。已保存历史可在 Piko app 或 /recent 查询。

当前使用持久消息编辑，不使用 Telegram draft。平台消息 ID、发送进度和别名只在内存；重启可能漏发、网络超时重试可能重复，不承诺恰好一次投递、不自动补发旧回复。主动通知和可靠补发需要单独设计只引用原生消息的 outbox。

## RN 如何发现另一通道的变化

RN 前台持续观察 GET /api/chat/events，输入 POST 与事件订阅分开；空闲时也会接收 Telegram 消息带来的变化。Telegram 服务端持续观察主会话助手输出，不按输入通道筛选；各通道使用自己的呈现方式。snapshot 提供最近一页历史、向前游标和状态，message 更新当前气泡；每次连接（包括重连和后端重启后）都先接收最新 snapshot，再观察实时更新，不携带事件游标或补齐中间事件。

后台和卸载只退订，前台重新观察；不会重投任务。网络不确定的 POST 重试同一 requestId，明确拒绝释放乐观输入、恢复草稿。较新事件到达后丢弃过期 HTTP 刷新，不覆盖当前回复。键盘、滚动与布局使用统一的聊天交互规则。这仍是前台同步，系统通知和后台唤醒尚未实现。

## 配置与生命周期

Telegram 由统一应用配置入口加载，严格分工：piko.json 的 channels.telegram 只管理 enabled 与 userId；Token 只从 PIKO_TELEGRAM_BOT_TOKEN（私有 config/.env 或进程环境）读取。没有 JSON/env 双入口；行为配置只从 JSON 读取，同名环境变量会被忽略，JSON 不接受 botToken。默认关闭，仅有 Token 不启用。已启用但缺 Token 或数字用户 ID 无效拒绝启动，不自动降级成关闭 TG；JSON 结构/放错位置错误同样拒绝启动。关闭 TG 时不校验凭据。见[应用配置](../operations/configuration.md)。凭据不放入工作区、RN bundle、共享响应或日志。

piko.json：

```json
{"channels":{"telegram":{"enabled":true,"userId":"自己的数字用户 ID"}}}
```

后端凭据：

```powershell
$env:PIKO_TELEGRAM_BOT_TOKEN = "<BotFather 提供的 token>"
bun run dev:api
```

也可使用 `bun run dev` 同时运行 RN；模型配置和工作区路径规则与后端一致。TG 配置变更需要重启。会话数据使用 `state/durable` 下的 SQLite；模型配置见[Agent 运行时说明](../operations/agent-runtime.md)。

只接受该用户与 Bot 的普通私聊，不接受群聊、频道、私聊话题或业务代发。回复使用经过校验的实际 chatId，不根据 username 认证，不将任意多个允许用户接入同一个个人主会话。多用户隔离后续单独设计。

采用 grammY 和 long polling，与 Bun 后端同进程运行；不需要为 TG 打开公网入站 HTTP 端口，但后端必须能够出站连接 Telegram。long polling 与 webhook 互斥；采用 grammY 默认行为，启动自动删除 webhook，不设置 drop_pending_updates=true，不主动清空待处理更新。[部署文档](https://grammy.dev/guide/deployment-types)、[Telegram getUpdates](https://core.telegram.org/bots/api#getupdates)

bot.ts 使用 grammY Bot.start() / Bot.stop()，SDK 管理游标、确认和轮询恢复。轮询 timeout 为 5 秒，小于客户端 10 秒请求超时。网络错误和服务端错误由 grammY 持续重试；429 按 retry_after 等待。bot.catch 仅记录脱敏的 update handler 错误，继续处理后续输入。管理操作与按钮处理作为受追踪后台任务执行，网络发送不占用 polling 接纳。

启动顺序：工作区/锁/原生历史校验 → 共用会话业务 → HTTP 与可选 TG。TG handler 只等待身份验证和持久化接纳，不等待整轮生成或长时间发送；其后独立观察和发送，否则顺序处理 update 会阻塞 `/stop`。必须显式追踪后台观察/发送 promise，并处理异常；不能只用不受管理的 fire-and-forget。[grammY long polling](https://grammy.dev/guide/deployment-types#how-to-use-long-polling)

明确启用 TG 却缺 Token 或用户 ID 无效时，配置校验直接拒绝启动并只报告字段名。已启用通道的构造/启动失败、或 grammY 因 401/409 等致命错误终止轮询时，报告脱敏错误，按正常关闭顺序清理整个后端并以非零状态退出；是否自动重启由实际运行环境决定。网络抖动由 grammY 重试。自动重启不能修复无效凭据或重复实例，需要处理对应配置/实例；没有通道健康管理 UI。配置与 Bot 身份仅在启动时加载，修改后重启生效。

退出先拒绝新输入，停止 TG polling 与 HTTP 接纳，再按现有逻辑取消/等待原生任务，在有界时间内收尾投递，退订并关闭会话、runtime 和锁。TG 退出异常不能跳过共用资源清理。同一 Bot 只运行一个 poller；现有状态目录锁不能阻止其他机器/其他状态目录启动同一 Bot。

## 验证状态与限制

隔离环境已覆盖 Telegram 命令与菜单、模型/思考选择、压缩生命周期、来源校验、任务/后台工作浏览及回复编辑失败处理。验证未使用真实模型供应商或真实 Telegram Bot。

真实 Telegram 客户端、网络限流、真实模型长对话以及 Android/iOS 前后台体验尚未验证。当前没有可靠投递 outbox；网络失败或进程重启可能导致回复漏发或重复。

## 后台委派回复

Telegram 的 `/subagent` 只提供手动只读浏览，不创建子 Agent，也不发送子会话完成推送。后台工作结果以可信内部 follow-up 交给主 Agent；子会话原文不直接发布。若主 Agent 在 root 主会话中生成回复，该助手消息不按原始输入来源区分，照常投递到 Telegram；主 Agent 保持安静则没有回复消息。普通 `/stop` 保留独立子任务，明确取消子工作由主 Agent 的委派工具处理。平台发送状态仍在内存，重启不保证补发，详情见[后台子 Agent](background-subagents.md)。
