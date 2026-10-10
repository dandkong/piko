# RN 与 Telegram 双通道

状态：首期代码已接入，包含可选 TG 私聊与 RN 前台同步；自动化使用模拟 Bot API/运行时，不连接真实 Telegram。真实 Bot、客户端富文本和 Android/iOS 前后台行为仍待验证。

## 目标与范围

RN 继续提供完整产品体验，Telegram 提供适合聊天界面的能力，不要求两个通道功能对齐。两个入口使用同一个助手工作区、主 Thread 和 Agent 上下文；通道只决定如何接收输入、呈现回复，不创建独立 Agent 或另一套历史。

例如：用户在 TG 要求整理工作区文件，随后打开 RN，可以看到相同的输入、回复与执行状态，并继续交流。RN 发起的回复默认不主动发送到 TG；需要时可以在 TG 查询最近历史。共享历史不等于双向复制所有平台消息。

| 能力 | 已接入范围 |
| --- | --- |
| 私聊文本 | 接受一个明确配置的用户；复用主会话、工作区、技能和现有工具 |
| 助手回复 | typing、800ms 节流更新、流式 Rich Markdown、长消息拆分与纯文本降级 |
| 停止与状态 | `/stop`、`/status`；停止作用于共享主会话，包括 RN 发起的当前 Run |
| 查询 | `/recent`、`/skills`、`/plugins`；只读查询已有能力 |
| 帮助 | `/start`、`/help`，说明共享会话、忙碌策略与支持范围 |
| RN 同步 | 在前台发现 TG 发起的新 Run，复用现有快照与 Run SSE 观察 |

首期仍可通过文本要求助手读写文件、运行脚本和维护技能，执行权限与现有 RN 一致。TG 不需要实现文件浏览器或技能管理页面才能使用这些已有能力。

以下能力留待独立讨论：附件上传/产物发送、图片理解、语音转写、群聊/话题、多用户、side chat、运行中追加输入、后台任务通知、审批按钮、Activity/Goals 等复杂页面、Mini App，以及修改模型/预设/思考强度、重载、手动压缩等管理命令。不复制 pi-pilot 的 `/new`、`/resume`、工作区切换或 `/exit`。

`/recent` 默认查询最近 10 条用户可见消息，以原生历史投影为准；只返回用户/助手文本，不泄露隐藏提示、思考或工具原始结果。历史查询不触发模型、不重新执行任务。未知命令和不支持的媒体给出说明，不悄悄当成模型输入。编辑旧 TG 消息不修改 Pi 历史，也不触发新 Run；引用旧消息首期只作为回复定位，不附带额外上下文。

## 当前代码与 pi-pilot 对照

| 关注点 | Piko 当前实现 | pi-pilot 参考与取舍 |
| --- | --- | --- |
| 输入入口 | `server/app.ts` 校验请求并调用 `ConversationStore.startRun` | `src/adapters/telegram.ts` + `src/runtime/chat-runtime.ts` 接收 TG 输入；借鉴传输适配，不复制整套运行时 |
| 执行与观察 | `server/chat/conversations.ts`、`run.ts` 管理 Run；HTTP/SSE 已独立于执行 | `src/render/turn-stream.ts` 分离回复呈现；借鉴节流和串行发送 |
| 运行中输入 | 同 Thread 只允许一个活跃 Run | pi-pilot 使用 `whenBusy: "steer"`；首期保持 Piko 的忙碌拒绝，不接入 steering |
| 会话与工作区 | 稳定 UUID、唯一主会话、SQLite 元数据、每 Thread 原生日志目录 | pi-pilot 支持选择 conversation 和工作区；保留 Piko 模型 |
| 回复地址 | RN 自行观察指定 Run | pi-pilot 可使用默认通知地址；Piko 按实际输入私聊回复，不采用首个允许用户作为投递地址的推断 |
| 命令 | 现有运行时描述 API 已有技能、插件和模型信息 | pi-pilot 的命令解析和按钮可参考；仅开放首期清单 |
| 持久化 | Durable JSONL 是唯一正文来源 | pi-pilot 也明确输入去重不等于 TG 回复恰好投递一次；首期同样不承诺持久 outbox |

参考的是当前 pi-pilot 源码，具体文件为 `src/adapters/{types,telegram}.ts`、`src/runtime/{chat-runtime,chat-commands}.ts`、`src/render/{turn-stream,chunking}.ts` 与 `docs/durable-experiment.md`，不依赖另一份项目在用户机器上的位置。

消息展示已对齐 pi-pilot 的持久 Rich Message 与编辑更新：从流式首条开始使用富文本，通过 remend 1.3.1 补全未闭合 Markdown，使用 30,000 单位的富文本拆分上限与 800ms 更新间隔。工具展示尚未接入；后续工具信息按独立普通消息呈现，使用通道已有的 plain 模式，不混入助手 Rich Markdown。

继续保留 Piko 的投递保护：网络错误不能一概按富文本不支持来降级；附件必须在任何下载或执行前验证身份。多段消息更新还需要处理正文缩短、分段变少和重试 replace。

## 依赖方向与接入位置

```text
RN ── HTTP/SSE ───────────┐
                         ├── 会话业务（主 Thread / Run / 历史 / 停止）
TG ── Telegram 适配器 ────┘                    │
                                       运行时接口
                                            │
                                   pi-durable / pi-ai
```

`server/channels/telegram/` 负责身份检查、update/命令解析和回复呈现；配置由 `server/config.ts` 统一加载后注入。由 `server/index.ts` 在同一个进程中启动；直接注入同一个 ConversationStore，不绕回本机 HTTP，也不额外创建 Harness 或数据库。RN 仍使用现有 HTTP/SSE。

- 会话业务负责统一文本校验、身份预留、去重、忙碌判断、取消和历史；`server/chat/input.ts` 提供统一文本校验，ConversationStore 提供 `startRun`、`startTelegram` 与 `stopTelegram`，保持 RN HTTP 状态与 SSE 协议。
- Telegram SDK 对象、平台 ID、按钮和 API 错误只留在通道目录，不进入 `server/runtime/` 或 `shared/`。
- 现有 `ChatRun.snapshot`、`subscribe`、`ConversationStore.history/run/startRun` 可复用；TG 的订阅回调只更新本地发送状态，不 await 网络请求、不向 Run 抛异常。
- `/skills`、`/plugins` 从运行时描述读取，格式化留在通道侧；不读取凭据、不新增模型执行。
- 首期没有必要让 RN 实现一个带 `sendMessage` 的通用 ChatAdapter，或建立插件式通道注册框架。先沿现有业务边界接入第二个入口。

## 会话、并发与输入去重

一个工作区仍只有一个主 Thread 和一个活跃 Run。无论哪一个通道先提交，另一个在运行期间都返回“主会话正在回复，请等待或停止”。拒绝的文本不进入原生历史、不加入待执行队列。忙碌消息重投不能在空闲后意外成为新任务。

SQLite 的 `telegram_inputs` 保存精简的 TG 输入及停止命令收据元数据：

| 字段 | 用途 |
| --- | --- |
| botId / chatId / messageId | 外部输入唯一键；使用 Bot 稳定数字 ID，不使用可轮换的 token |
| actorId / threadId | 已验证输入来源与目标主 Thread |
| runId | 接受输入或停止命令对应的 UUID；拒绝输入/接收时空闲的停止命令为空 |
| inputHash / disposition / createdAt | 哈希、接受/忙碌拒绝/无效拒绝/停止决定与时间；不保存正文 |

外部平台 ID 使用字符串保存；实体 ID 仍为 UUID，时间使用 Unix 毫秒数。收据唯一键与 Run 预留必须在同一个 SQLite 事务内提交；已有收据先于忙碌判断，重复输入返回原决定，相同外部键不同正文拒绝。事务提交后才启动执行和确认 update；收到重复 update 不生成新 UUID 或再次调用模型。首次未完成预留的输入可以重新接收；已有 Run 的不确定执行按现有重启策略标记中断，不自动重跑。

RN 继续使用客户端 runId 和现有去重规则。收据是外部请求的身份/决定记录，不是第二套消息正文、输入任务队列或永久 SSE 日志。当前 SQLite schema=1；旧 schema 明确拒绝，不自动迁移或删除，使用新 `PIKO_HOME` 测试。没有持久化用户文本、回复或 TG 消息发送状态。

鉴权或来源范围不符的 update 在进入会话业务前拒绝，不读主会话、不创建收据、不调用工具。授权必须同时覆盖普通文本和命令；后续加 callback 或媒体时也必须在入口检查。

## 回复呈现与投递

TG 发起的 Run 只回复已验证的输入私聊，第一条回复关联输入 `messageId`。所有内容仍来自原生历史与当前 Run 的内存快照。RN 发起的 Run 默认不产生 TG 推送；`/recent` 可主动查看。帮助、状态、忙碌和错误提示属于通道反馈，不额外写成 Agent 对话。

采用与 pi-pilot 相同的“发送持久 Rich Message 后节流编辑”：首条与后续流式更新均通过 `sendRichMessage` / `editMessageText` 的 `{ markdown }` 呈现，支持 Telegram 原生标题、列表、表格和代码块。流式阶段用 remend 补全未闭合 Markdown，未完成链接只展示文本，不生成 `streamdown:` 占位链接，单个美元符号不自动补为数学公式；最终更新使用正文，不保留流式补全的标记。渲染补全仅作用于 TG 展示，不修改 Run 快照、原生历史或 RN 内容。[Rich Messages](https://core.telegram.org/bots/api#rich-messages)

这套实现使用持久消息编辑，不使用 `sendRichMessageDraft`。Telegram draft 是临时预览；draft、预览保活及原生停止事件仍留作后续优化。[Bot API 文档](https://core.telegram.org/bots/api#sendrichmessagedraft)

当前处理规则：

- 以 800ms 合并最新快照，串行发送/编辑；吞掉无变化编辑，遵守 429 的 `retry_after`。typing 在等待工具或模型期间按平台需要续发。更新间隔与 pi-pilot 一致，实际以 API 响应调整。[官方频率说明](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)
- RN 保持现有 delta/replace；TG 将两者映射为完整文本更新。不能只追加 delta，否则模型重试会留下被撤回文字。
- 富文本使用与 pi-pilot 相同的 30,000 UTF-16 单位上限；普通消息使用保守的 4,000 单位上限。避免拆开代理对，优先按行切分，富文本代码围栏在分段间补全。明确格式/能力拒绝后，将整份快照重新按普通消息上限拆分，并让该次回复的后续更新保持纯文本；普通消息保留字面内容。正文缩短时编辑已有消息、删除多余段落。
- 收到 done/cancelled/error 后，以最终快照或原生历史核对正文，并标明停止/失败；先完成 Piko 原生保存，再认定执行完成。
- 网络超时、429 与永久权限错误分别处理；每次请求最多 3 次尝试，429 遵守 `retry_after`，超过 15 秒的冷却直接报告投递失败；确认格式拒绝才切换渲染方式。不把发送超时后再次发送描述为恰好一次投递。
- 发送失败不改变 Run 的成功状态，不取消模型任务，不以重新执行模型来补发。有限重试仍失败时保留原生历史，日志不包含 token/完整请求 URL，用户可在 RN 或 `/recent` 查询。

帮助、状态、忙碌、错误反馈与 `/recent` 查询使用普通消息；当前不推送工具调用、参数或结果。后续工具展示可复用 plain 模式，但运行时事件投影、工具格式与分段时序需在接入时实现。

首期发送进度和平台消息 ID 只在内存中。进程在回复保存后、TG 接收前退出，可能漏发；发送超时也可能造成重复平台消息。不自动补发旧回复、不重建 TG 全量历史、不承诺重启后恢复正在编辑的消息。将来需要主动通知或可靠补发时，再设计只保存原生 entry/Run 引用与投递状态的 outbox。

`/stop` 在收据事务中保存当前活跃 runId，再取消该 Run；接收时空闲则保存空目标。重投只处理原目标，不会停止之后的新任务。如果后续增加停止按钮，也必须绑定具体 runId。回复观察断开、TG 网络断开或 RN 退后台均不等于取消执行。

## RN 如何发现另一通道的变化

`apps/mobile/src/features/chat/useChat.ts` 保留初次打开、回前台与已有 Run 观察流程，并通过 `sync.ts` 发现另一通道的新消息。当前没有主会话级推送订阅或永久事件系统。

页面前台、没有观察者和未提交输入时，每 3 秒读取会话快照；没有变化不更新消息列表。请求 10 秒超时，失败退避到最多 30 秒；轮询间隔可按实际负载调整。

- 不直接重复调用现有 `refresh()`：它会中止观察者、切换 loading/busy。新增静默同步路径，只有内容变化才更新列表。
- 发现活跃 Run 后停止空闲轮询，接入现有 Run SSE；Run 完成后读取原生历史，再恢复空闲发现。
- 较短 Run 在两次轮询之间完成时，仍通过历史快照发现。重复快照不产生重复气泡。
- 后台/页面卸载停止轮询，回前台立即读快照。失败有限退避，不打断现有回复。
- 在请求发出后 RN 可能开始本地提交；利用版本/观察者检查丢弃过期响应，不覆盖输入草稿、乐观消息或新 Run。
- RN 提交被忙碌等明确 HTTP 错误拒绝时，释放未接纳的乐观状态并恢复草稿，后续静默同步可以发现另一端的任务；网络不确定的提交仍保留原有去重恢复语义。
- 保持已确认的键盘、焦点、滚动与布局交互；新历史的显示遵守原有“查看旧消息/回到最新”规则，不强制拉到底部。

这只是前台共享会话同步，不等于系统通知或后台唤醒。随着历史规模增长，再考虑会话级变更通知和增量加载。

## 配置与生命周期

Telegram 配置由统一应用配置入口加载，使用 `PIKO_HOME/config/piko.json` 的 `channels.telegram`，也可由 `config/.env` 或进程环境覆盖。默认关闭，显式设置 `enabled: true` 或 `PIKO_TELEGRAM_ENABLED=true` 后启用；仅设置 token 不启用。启用时必须有 token 与有效数字用户 ID，配置错误仅停用 TG，RN 仍可运行。字段与优先级见 [应用配置](application-config.md)。凭据不放入助手工作区、RN bundle、共享响应或日志；不复用模型 `auth.json` 的供应商凭据格式。

```powershell
$env:PIKO_TELEGRAM_ENABLED = "true"
$env:PIKO_TELEGRAM_BOT_TOKEN = "<BotFather 提供的 token>"
$env:PIKO_TELEGRAM_USER_ID = "<自己的数字用户 ID>"
bun run dev:api
```

也可使用 `bun run dev` 同时运行 RN；模型配置和工作区路径规则与原有后端一致。TG 配置变更需要重启。首次升级遇到旧 schema 时，先停止后端并保留旧 `PIKO_HOME`，指定一个新的绝对路径测试，再按 [Durable 配置](durable-runtime.md) 配置模型；不要直接删除旧状态。

只接受该用户与 Bot 的普通私聊，不接受群聊、频道、私聊话题或业务代发。回复使用经过校验的实际 chatId，不根据 username 认证，不将任意多个允许用户接入同一个个人主会话。多用户隔离后续单独设计。

采用 grammY 和 long polling，与 Bun 后端同进程运行；不需要为 TG 打开公网入站 HTTP 端口，但后端必须能够出站连接 Telegram。long polling 与 webhook 互斥，启动发现已配置 webhook 时明确报错，不静默删除。[部署文档](https://grammy.dev/guide/deployment-types)、[Telegram getUpdates](https://core.telegram.org/bots/api#getupdates)

`bot.ts` 使用 grammY API 接收 update 并交给 `handleUpdate`，自己管理轮询游标：接纳成功后才增加 offset，不调用会自动删除 webhook 的 `Bot.start()`，也不调用会确认最后尝试 update 的 `Bot.stop()`。持久化接纳失败停止该通道，不确认失败输入；重启可重投，既有收据负责去重。

启动顺序：工作区/锁/数据库/原生历史校验 → 共用会话业务 → HTTP 与可选 TG。TG handler 只等待身份验证和持久化接纳，不等待整轮生成或长时间发送；其后独立观察和发送，否则顺序处理 update 会阻塞 `/stop`。必须显式追踪后台观察/发送 promise，并处理异常；不能只用不受管理的 fire-and-forget。[grammY long polling](https://grammy.dev/guide/deployment-types#how-to-use-long-polling)

TG 启用失败或运行中失联报告到后端日志，并保留 RN 使用能力；首期没有通道健康管理 UI。配置错误在开始接收 TG 输入前报错；认证失效、重复 poller 等永久错误停用该通道，网络错误有限退避仍失败也停用，修复后重启后端。配置与 Bot 身份仅在启动时加载，不混入 durable 插件重载。

退出先拒绝新输入，停止 TG polling 与 HTTP 接纳，再按现有逻辑取消/等待活跃 Run，在有界时间内收尾投递，退订并关闭会话、runtime、数据库和锁。TG 退出异常不能跳过共用资源清理。同一 Bot 只运行一个 poller；现有状态目录锁不能阻止其他机器/其他状态目录启动同一 Bot。

## 验证与后续边界

已接入共享接纳、收据、私聊命令、节流呈现和 RN 静默同步。新增测试位于 `tests/telegram.test.ts` 与 `tests/chat-sync.test.ts`；原有运行时与 HTTP/SSE 测试继续覆盖持久化、工具和恢复。

自动化验证使用模拟 Bot API、现有 faux runtime 和临时目录，不读取个人 Bot token：

- 未授权用户、群聊和不支持类型不读取历史或启动工具；命令也受同样检查。
- 同一 TG 消息重投、重启后重投不重复执行；重复忙碌消息不会后来自动执行；不同正文复用同一身份拒绝。
- RN/TG 并发只有一个输入被接纳，另一个明确忙碌；跨通道停止实际取消同一 Run。
- 发送延迟不阻塞 `/stop`，TG 发送失败不破坏 Run/SSE；429、超时、格式错误分开处理。
- 通过本机模拟 Bot API 验证流式首条 `sendRichMessage`、后续富文本 `editMessageText` 与最终正文；Unicode/代码块长回复、表格、未闭合 Markdown、超长富文本降级后的重新拆分、正文 replace/缩短、取消/失败与空回复正确呈现；原生历史不受 TG 渲染、分段或命令查询影响，内建工具结果不推送。
- RN 前台发现新 Run、错过短 Run、过期快照竞争、后台恢复及观察者去重。
- TG 未启用/失联时 RN 可用；启动和退出没有未处理 promise 或遗留轮询/订阅。

已通过 `bun run typecheck`、`bun run test` 和 Android/Web bundle 导出。模拟测试覆盖接纳事务回滚、重投/重启去重、跨通道竞争与停止、旧停止命令重投、发送延迟/失败、429/鉴权错误分类、正文修正和分段删除、轮询确认与 webhook 拒绝，以及 RN 快照竞争和退避；另用 faux 模型验证 TG 与 RN 共用一个原生 durable conversation。iOS 导出本次未运行。

真实 Telegram 客户端富文本、429 行为、联网与 Android/iOS 前后台同步需真实 Bot/设备验证，不能以模拟测试或 bundle 导出代替。可靠 outbox、主动通知、媒体和复杂功能尚未实现。
