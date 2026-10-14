# RN 与 Telegram 双通道

状态：文本首期已实现，共用原生主会话、提交去重和执行状态；Piko 不再维护 SQLite 或 Run。架构见 [ARCHITECTURE](../ARCHITECTURE.md)。

## 目标与当前范围

RN 提供完整产品体验，Telegram 接入适合私聊的功能，不要求所有功能对齐。两个入口共享工作区、root conversation、历史、当前模型和思考强度；通道各自呈现输入、回复和反馈。

| 能力 | 当前实现 |
| --- | --- |
| 普通文本 | 运行中仍可发送，原生 steer all |
| 回复 | 每条助手消息独立 Rich Markdown，条内流式编辑 |
| 停止与状态 | /stop、/status；可停止 RN/TG 当前工作及手动压缩 |
| 历史与资源 | /recent 最近 10 条可见消息，/skills |
| 模型与思考 | /models 供应商/模型按钮，/thinking 当前模型支持的强度 |
| 压缩 | /compact，区分应用、跳过、取消和失败，聊天历史保留 |
| 帮助 | /start、/help |
| RN 同步 | 前台持续会话 SSE，接收 TG 输入和回复 |

菜单只在内存保存来源和目录快照，callback 再次鉴权、验证来源和能力。模型选择使用原生 Conversation.configure，选择保存在 Agent 文档；命令和反馈不写成模型消息。管理操作需空闲，普通输入接纳与管理预留共用串行入口；停止不被长时间压缩阻塞。

内建文案为简洁英文，用户内容、模型回复、模型和技能名称保留原文。帮助使用 Piko app 指代 RN 入口。未知命令与不支持媒体给出提示；编辑旧 TG 消息不修改历史、不触发模型，引用消息不额外注入上下文。附件、群聊、语音、工具展示和后台推送尚未接入。

## 当前代码与 pi-pilot 对照

| 关注点 | Piko 当前实现与取舍 |
| --- | --- |
| 输入 | channel.ts → ConversationStore.submit → 原生 submission |
| 并发 | whenBusy=steer、steeringMode=all；输入与输出各自展示 |
| 执行观察 | 共享会话流；watchEvents 留在 Pi 适配器 |
| 会话 | 一个 PIKO_HOME 一个 Harness/root，不另存会话表 |
| 命令 | 复用运行时描述、选择和压缩，保持空闲限制 |
| 呈现 | 与 pi-pilot 的持久 Rich Message、remend 和节流编辑对齐 |
| 投递 | 实际已验证私聊地址，不推断默认通知地址；无持久 outbox |

参考 pi-pilot 的 adapters/telegram、runtime/chat-runtime、chat-commands 与 render/turn-stream、chunking。工具将来按独立普通消息展示，不混入助手 Rich Markdown，当前不消费工具呈现事件。

## 依赖方向与接入位置

RN 经 HTTP/SSE，TG 直接注入同一个 ConversationStore。server/channels/telegram 处理 SDK、身份、命令、轮询和网络呈现；配置由 server/config.ts 加载。会话业务协调输入/管理互斥和临时观察，原生执行、去重、inbox 与持久状态由 server/runtime 内 Durable 适配器处理，不额外创建 Harness 或数据库。

## 会话、并发与输入去重

TG 使用 telegram:<botId>:<chatId>:<messageId> 作为原生 requestId，不使用可轮换 token。重复已接纳输入返回原提交，不再调用模型或投递回复；不另存哈希或拒绝收据。同 ID 代表同一请求，新内容必须新身份。Telegram update 的游标与确认由 grammY 默认轮询管理，不再与 Durable 接纳成功严格绑定；handler 失败记录脱敏错误并继续处理，不能承诺失败输入一定重投。原生 requestId 去重保留，但不等于端到端无丢失。

运行期间输入进入原生 inbox，在工具轮或最终回复的接纳边界一起应用，不打断已经开始的模型/工具。维护期间立即拒绝普通输入，不把它留到维护后执行；拒绝不产生原生提交。执行失败结算并撤回未应用补充，不自动重跑；停止也撤回未应用输入。未落入原生用户 entries 的撤回输入不进入最终历史。

/stop 身份追加 :stop；原生 piko.stop 文档保存当时 task ID 和结果，重投只操作这些任务，不停止后来的工作。空闲停止也保存空目标。RN 停止使用相同机制的 UUID 请求。连接断开、TG 网络错误和 RN 退后台均不等于停止。

鉴权和来源检查在读历史、创建提交、执行工具或下载前完成；只接纳指定用户普通私聊。启动重启策略见 [工作区与主会话](workspace-and-main-chat.md)。

## 回复呈现与投递

助手回复、命令反馈和菜单直接发送到验证后的私聊，不引用用户消息。用户 messageId 负责输入去重，菜单 messageId 用于编辑和来源校验。

TG 投递观察独立于输入提交，每条原生助手消息对应一个投递对象，条内流式编辑；保存时以原生 ID 替换临时 ID，补充输入不会重发之前的回复。TG 加入 RN 正在执行的工作只观察未完成和后续消息，不补发已完成回复；纯 RN 工作不默认推送 TG，可用 /recent 查询。

- 首条用 sendRichMessage，后续 editMessageText 的 rich_message.markdown；使用 remend 1.3.1 补全未闭合 Markdown、未完成链接仅显示文本，最终发送原正文。渲染修复不改原生历史或 RN 内容。
- 每条消息按 800ms 合并最新状态，串行发送/编辑，跳过无变化更新；等待模型或工具时续发 typing。连续完成的多条消息分别发送，不合并成整轮回复。
- 富文本上限 30,000 UTF-16 单位，普通消息保守使用 4,000；不拆开代理对，优先按行拆分，富文本分段修补代码围栏。正文缩短时编辑、删除该条多余段，保留前面回复。
- 只在明确格式拒绝时降级，并按普通上限重新拆分该条；后续保持普通文本。网络、429、认证失败不当作格式问题，每次请求最多 3 次尝试，遵守 retry_after；超过 15 秒冷却报告投递失败。
- 原生失败或停止给出简短普通反馈；帮助、状态和历史查询也使用普通消息，不推送工具原始结果、思考和隐藏指导。
- 发送失败不取消模型、不修改提交成功状态，也不重新运行模型补发。已保存历史可在 Piko app 或 /recent 查询。

当前使用持久消息编辑，不使用 Telegram draft。平台消息 ID、发送进度和别名只在内存；重启可能漏发、网络超时重试可能重复，不承诺恰好一次投递、不自动补发旧回复。主动通知和可靠补发需要单独设计只引用原生消息的 outbox。

## RN 如何发现另一通道的变化

RN 前台始终观察 GET /api/chat/events，与 POST 输入分开；空闲时也接收 TG 变化，删除原先 3 秒轮询和按 Run 切换观察。snapshot 提供最近一页历史、向前游标和状态，message 更新当前气泡；epoch/sequence 用于重连，缓存失效或后端重启直接接收新 snapshot。

后台和卸载只退订，前台重新观察；不会重投任务。网络不确定的 POST 重试同一 requestId，明确拒绝释放乐观输入、恢复草稿。较新事件到达后丢弃过期 HTTP 刷新，不覆盖当前回复。键盘、滚动、布局保持原有交互。这仍是前台同步，系统通知和后台唤醒尚未实现。

## 配置与生命周期

Telegram 由统一应用配置入口加载，严格分工：piko.json 的 channels.telegram 只管理 enabled 与 userId；Token 只从 PIKO_TELEGRAM_BOT_TOKEN（私有 config/.env 或进程环境）读取。没有 JSON/env 双入口；行为配置只从 JSON 读取，同名环境变量会被忽略，JSON 不接受 botToken。默认关闭，仅有 Token 不启用。已启用但缺 Token 或数字用户 ID 无效只停用 TG；JSON 结构/放错位置错误则拒绝启动。见 [应用配置](application-config.md)。凭据不放入工作区、RN bundle、共享响应或日志。

piko.json：

```json
{"channels":{"telegram":{"enabled":true,"userId":"自己的数字用户 ID"}}}
```

后端凭据：

```powershell
$env:PIKO_TELEGRAM_BOT_TOKEN = "<BotFather 提供的 token>"
bun run dev:api
```

也可使用 `bun run dev` 同时运行 RN；模型配置和工作区路径规则与原有后端一致。TG 配置变更需要重启。当前固定使用 state/durable，不迁移旧聊天；模型配置见 [Durable 配置](durable-runtime.md)。

只接受该用户与 Bot 的普通私聊，不接受群聊、频道、私聊话题或业务代发。回复使用经过校验的实际 chatId，不根据 username 认证，不将任意多个允许用户接入同一个个人主会话。多用户隔离后续单独设计。

采用 grammY 和 long polling，与 Bun 后端同进程运行；不需要为 TG 打开公网入站 HTTP 端口，但后端必须能够出站连接 Telegram。long polling 与 webhook 互斥；采用 grammY 默认行为，启动自动删除 webhook，不设置 drop_pending_updates=true，不主动清空待处理更新。[部署文档](https://grammy.dev/guide/deployment-types)、[Telegram getUpdates](https://core.telegram.org/bots/api#getupdates)

bot.ts 使用 grammY Bot.start() / Bot.stop()，SDK 管理游标、确认和轮询恢复，不再维护自定义 getUpdates 循环。轮询 timeout 为 5 秒，小于客户端 10 秒请求超时。网络错误和服务端错误由 grammY 持续重试；429 按 retry_after 等待。bot.catch 仅记录脱敏的 update handler 错误，继续处理后续输入。管理操作与按钮处理作为受追踪后台任务执行，网络发送不占用 polling 接纳。

启动顺序：工作区/锁/原生历史校验 → 共用会话业务 → HTTP 与可选 TG。TG handler 只等待身份验证和持久化接纳，不等待整轮生成或长时间发送；其后独立观察和发送，否则顺序处理 update 会阻塞 `/stop`。必须显式追踪后台观察/发送 promise，并处理异常；不能只用不受管理的 fire-and-forget。[grammY long polling](https://grammy.dev/guide/deployment-types#how-to-use-long-polling)

配置校验发现缺 Token 或无效用户 ID 时仍只停用 TG。已启用通道的构造/启动失败、或 grammY 因 401/409 等致命错误终止轮询时，报告脱敏错误，按正常关闭顺序清理整个后端并以非零状态退出；部署需配置服务管理器自动重启（Linux 模板为 Restart=on-failure）。网络抖动不因尝试三次失败就永久停用 TG。自动重启不能修复无效凭据或重复实例，需要处理对应配置/实例；首期没有通道健康管理 UI。配置与 Bot 身份仅在启动时加载，修改后重启生效。

退出先拒绝新输入，停止 TG polling 与 HTTP 接纳，再按现有逻辑取消/等待原生任务，在有界时间内收尾投递，退订并关闭会话、runtime 和锁。TG 退出异常不能跳过共用资源清理。同一 Bot 只运行一个 poller；现有状态目录锁不能阻止其他机器/其他状态目录启动同一 Bot。

## 验证与后续边界

使用临时目录、原生 faux provider 和本机模拟 Bot API，无真实 Bot 凭据或付费模型调用。自动化覆盖鉴权、原生提交重投、RN/TG steer、独立助手消息、RN-only 与 TG 加入、旧停止命令、模型/思考菜单、压缩取消、流式首条/编辑、富文本降级与 Unicode 拆分、429/认证分类，以及 grammY 游标/停止确认、webhook 自动移除但不丢弃待处理更新、连续四次网络失败后恢复、handler 失败继续轮询、致命/启动错误触发服务恢复和启动取消。

会话持久化、重启中断、HTTP/SSE 游标恢复在 persistence、server、transport 等测试覆盖。真实 Telegram 客户端、网络限流和 Android/iOS 前后台体验需要设备验证；不能以模拟测试代替。媒体、工具展示、持久投递 outbox 和主动通知仍未实现。

## 后台委派回复

子 Agent 不增加 TG 命令、工具展示或完成通知。TG 输入发起的后台工作记录经过验证的 Bot/chat 来源；完成结果私下 follow-up 给主 Agent，必要时重新观察空闲后的 root 回复。只投递主 Agent 实际生成的文字，保持 Rich Markdown 与按助手消息独立发送；主 Agent 保持安静则没有通知，RN 来源不额外推 TG。普通 /stop 保留独立子任务，明确取消子工作由主 Agent 的委派工具处理。平台发送状态仍在内存，重启不保证补发，详情见 [后台子 Agent](background-subagents.md)。
