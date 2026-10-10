# Piko 架构约定

当前 Agent 底层为 pi-durable 1.1.0，模型适配为 pi-ai 1.1.0。体验见 [PRODUCT](PRODUCT.md)，进度见 [路线图](../ROADMAP.md)，用法见 [Durable 配置与插件](features/durable-runtime.md)。

## 当前结构

```text
Expo / React Native → HTTP + SSE ──┐
                                 ├── Bun 会话服务 → 运行时接口 → pi-durable → pi-ai
Telegram 私聊 → Bot API 适配器 ────┘
```

| 位置 | 职责 |
| --- | --- |
| apps/mobile/src/features/chat/ | 页面、输入、临时状态、主会话发现、HTTP/SSE |
| apps/mobile/src/components/、theme.ts | 通用布局、头像、导航和视觉 |
| server/app.ts、http.ts | 路由、校验、响应与 CORS；导入不监听端口 |
| server/index.ts、config.ts | 初始化、监听、单进程锁与退出清理 |
| server/chat/ | Run 生命周期、去重、取消、内存快照与事件重放 |
| server/channels/telegram/ | 可选私聊通道、身份检查、命令、轮询游标与回复呈现；直接复用会话业务 |
| server/domain/ | 工作区初始化、SQLite 身份/执行元数据、重启标记中断 |
| server/runtime/ | Durable/pi-ai 适配、JSON 配置、插件、资源范围、完整历史投影 |
| server/resources/ | 原有核心指导、内建技能、用户文件模板 |
| shared/ | 普通跨端类型与 SSE 契约，不依赖 Pi、Bun 或 React Native |
| tests/ | UI 逻辑、协议、API、并发、原生持久化、恢复、资源与插件验证 |

依赖方向：页面 → Hook/API → HTTP/SSE；路由/通道 → 会话业务 → 运行时接口 → Pi 适配器。Pi SDK 类型集中在 server/runtime，Telegram SDK 留在 server/channels/telegram；测试使用临时目录、faux provider 或本机模拟模型服务，不读取个人凭据。

Durable 是唯一 Agent 运行时和唯一会话内容存储。Piko 管理产品、工作区/Thread 关系、Run 生命周期和传输；不复制第二套消息正文或永久 SSE 日志，不引入 pi-server / pi-client。

## 工作区与状态

默认根目录为后端机器上的 `~/.piko`，独立于源码。进程环境 `PIKO_HOME` 定位根目录；应用配置 `workspace.path` 或 `PIKO_WORKSPACE` 可单独指定工作区，均要求绝对路径。

`server/config.ts` 是应用配置入口，env 只映射和转换字段，按默认值 < `config/piko.json` < `config/.env` < 进程环境合并后，统一校验 HTTP、工作区及 Telegram，再注入使用处。开发脚本使用同一入口。模型文件独立，复用通用 JSON/env 读取函数；不把 Pi SDK 配置类型移出 runtime。应用配置与模型配置修改后均重启后端生效。细节见 [应用配置](features/application-config.md)。

```text
~/.piko/
├── config/
│   ├── piko.json                   # HTTP、工作区、通道配置
│   ├── .env                        # 可选，应用与模型共用的本地环境变量
│   ├── settings.json               # 模型预设、默认预设、压缩/重试/传输设置
│   ├── models.json                 # 自定义供应商/模型和内建模型覆盖
│   └── auth.json                   # 供应商凭据
├── extensions/                    # durable 原生插件
├── skills/                        # 用户公共技能
├── state/
│   ├── backend.lock                # 单后端写进程
│   ├── piko.sqlite                 # 身份、Run 元数据、原生引用
│   ├── tmp/                       # 工具溢出与插件临时 bundle
│   └── durable-sessions/<thread-id>/
│       ├── main.jsonl              # 会话、entries、任务与提交事务
│       └── doc-*.jsonl             # 运行时/插件持久化文档
└── workspace/
    ├── AGENTS.md                   # 助手身份、表达和做事约定
    ├── MEMORY.md                   # 用户资料、环境事实和长期结论
    ├── .agents/skills/<name>/SKILL.md
    ├── memory/
    ├── projects/
    └── artifacts/
```

初始化只补缺失文件，保留用户内容，拒绝工作区类型冲突与越界链接。state 必须在工作区外。当前 SQLite schema 为 1，包含 TG 输入/停止命令身份和决定元数据；旧 schema 明确拒绝，不迁移或删除旧数据。配置不继承 `~/.pi/agent`。

## 模型、资源与插件

pi-ai 内建供应商目录配合 Piko FileCredentialStore；自定义 JSON 可指定 API、地址、模型能力、请求参数、headers 和适配兼容项。预设映射 provider/model/thinking；当前选择保存到 durable Agent 文档，重启保留。JSON 默认预设用于初始选择，修改默认预设不会覆盖会话已有选择。

模型配置和插件在创建原生 Harness 时加载，修改后重启后端生效；不提供运行时重载接口。模型/思考选择及压缩占用会话空闲边界，不与生成并发。普通指导与技能索引在每次模型请求时刷新，无需重开 Harness。

- 技能优先级：工作区 `.agents/skills` > `PIKO_HOME/skills` > 应用 `server/resources/skills`。同名覆盖有诊断，非法 YAML 跳过。
- 核心指导 `server/resources/prompts/core.md` 负责运行规则；工作区只加载 AGENTS.md（助手身份、表达和做事约定）与 MEMORY.md（用户资料、环境事实和长期结论）。注入时标注来源和角色，职责与冲突处理见 [资源与工具](features/workspace-and-main-chat.md#资源与工具)；角色标注不是权限隔离。core/AGENTS 各上限 8,000 字节，MEMORY 上限 4,000 字节，超量截断。技能只注入索引，正文按需 read。
- 显式资源范围，不发现祖先指导或个人 CLI 资源；UI 输入按原文处理，不展开 CLI 的 `/skill:` 命令。
- 插件从 `PIKO_HOME/extensions/*.ts|js|mjs` 或子目录 `index.ts|js|mjs` 加载，default export 为 durable Extension。支持 tools、sections、hooks、wraps、tasks，以及插件工具内使用原生持久化 doc。
- 插件使用 Bun 临时 bundle 刷新传递依赖，与宿主共享 Pi/Chord/TypeBox；外部依赖从插件目录解析。插件属于可信本机代码；不适配旧 CLI 扩展 UI/lifecycle API。
- read、write、edit、bash 使用 durable CodingTools，cwd 为工作区，临时输出在 state/tmp。本机权限与 cwd 不构成沙箱；目前没有单独操作审批 UI。
- 自动压缩、有限重试和手动压缩使用 durable 原生能力。1.1.0 的 read 暂不支持图片，工具进度、思考和产物专用 UI 尚未实现。

## 领域与历史投影

| 对象 | 当前职责 |
| --- | --- |
| Workspace | SQLite 保存稳定 UUID、规范化路径、创建时间 |
| Thread | main / side 类型；唯一 main，side 只预留 parentThreadId；原生会话引用 |
| Message | 指定 conversation 的完整原始 entries 临时投影；没有消息表 |
| Run | SQL 保存顺序、状态、输入 SHA-256、时间、重试来源、错误、状态游标；不保存正文 |
| TelegramReceipt | SQL 保存 Bot/chat/message 外部身份、用户、输入哈希、接纳/拒绝/停止决定与 Run 引用；无正文 |
| StreamEvent | 独立 message 快照、refresh、终态；最多 2,048 条内存重放 |
| Task / Artifact（后续） | 产品任务调度与产物管理；成果文件在工作区 |

实体 ID 为 UUID，时间为 Unix 毫秒数。每个 Thread 使用一个 durable session 目录与 root conversation。SQL 引用 `{version:2,directory:<thread UUID>,conversationId:<root ID>}`，不保存 leaf 或模型上下文快照。

历史在原生 Session 的事务内分页读取指定 conversation 的所有 entries，按 ID 正序投影，不使用压缩后的 `conversation.context()` 作为 UI 历史。用户/助手文本形成气泡，ID 为 `pi-<entry ID>`、时间来自原生 model message；隐藏内部标记、工具、思考、压缩摘要。`piko.result` 的 display=true 可形成被动结果气泡；目前没有产品投递入口。

`piko.input` state-only entry 只记录每条输入的 runId/createdAt，通过原生 submission 的 entry 引用关联用户条目，不保存正文。助手消息独立于输入，不写执行分组标记，不累计整轮回答或隐藏已完成条目。生成中使用临时消息 ID，提交后以原生 pi-<entry ID> 原位替换；完整原生历史加当前未提交消息构成实时快照。上下文编辑、reset 和压缩不删除 UI 原始消息。

## API 与执行

- GET `/api/main`：主 Workspace/Thread，sessionId 等于 Thread UUID。
- POST `/api/chat`：sessionId、runId、message、after?、retryOfRunId?；返回 SSE。
- GET `/api/sessions/:id`：完整原生历史、最近 Run 快照。
- GET `/api/sessions/:id/runs/:runId/events?after=N`：内存事件重放；过期/越界/重启后返回 409，客户端加载快照。
- POST `/api/sessions/:id/runs/:runId/cancel`：目标输入仍活跃时停止当前 conversation；断开观察连接只退订。
- GET `/api/runtime`：模型能力、选择、预设、技能、插件元数据；不返回凭据。
- POST `/api/runtime/selection|compact|cancel`：模型选择、手动压缩与停止；配置管理 UI 未实现。
- 不允许删除主会话或通过任意客户端 UUID 创建会话。

同 Thread 可有多个活跃输入 Run；Run 是提交身份与观察状态，不是助手消息或独立 Agent 执行。SQL 保存每条输入身份和状态。先预留身份/输入哈希，再调用 durable submit，requestId 为 run.id；重复身份和相同输入复用，不同输入拒绝。显式重试使用新 UUID、相同输入、失败 Run 引用。

运行中输入使用 `whenBusy: "steer"` 与 `steeringMode: "all"`，RN/TG 统一接纳；模型/思考选择和手动压缩仍在空闲执行。适配器串行接纳但并行等待 submission，输入排序与应用交给原生 inbox；输出独立监听 conversation 的助手消息，不与输入一一对应。停止取消当前 conversation 的执行及待应用输入；执行失败也撤回尚未应用输入并报告失败，不自动重跑。详见 [路线图](../ROADMAP.md#运行中输入steer-all已实现)。

queued → running → succeeded / failed；停止经过 cancelling → cancelled。终态先 fsync 原生 main 事务日志，再写 SQL 元数据，再发布终态；原生 storage 启用 fsync，doc 日志由其提交协议管理。存储失败阻止成功发布，并停止后续提交。同一消息的未完成快照最多 50 毫秒合并，不落盘；retry 只更新当前消息正文，已提交助手消息继续独立展示。

Pi 适配器通过 durable `watchEvents` 消费原生消息事件，转换为带消息 ID、正文和 final 标记的 Piko message 事件，以及用户/助手条目进入历史的 refresh。首次连接不重放旧回复，积压替换 snapshot 用完整原生 entries 补齐遗漏的新消息，不以有效上下文覆盖 UI 历史。Run 发布终态前等待对应 submission 终态事件消费，并核对完整原生历史。SDK 事件不直接进入 shared 或通道层，工具与自动压缩展示仍待接入。GET 会话支持 `?runId=`，重连按原输入身份查询，其他通道的补充输入不会使旧观察者丢失目标。

SSE 15 秒心跳，客户端 45 秒无数据恢复并有限退避。观察者断线不取消任务，回前台加载快照。正在运行的快照与重放在内存中，重启不承诺恢复未保存片段。

## 恢复、退出与备份

启动用原生 JSONL storage 校验主会话，不启用任务调度。已引用日志缺失、目录身份不符、完整记录损坏拒绝继续。durable 原生恢复截断末尾半条记录、处理未确认 sidecar 事务；Piko 不再维护旧格式解析器或 `.torn-*` 归档。

SQL 遗留活跃 Run 标记 failed + interrupted。第一次打开 Harness 时，在启用普通生成前调用 `abort({background:true})` 撤销遗留作用域工作，避免工具/模型自动重放。中断说明以隐藏原生 entry 写入上下文，原生 doc 按 runId 去重，不重复输入、不触发回复。Piko 明确保持用户再次提交后才执行的产品语义。

原生日志与 SQL 不构成跨存储事务：日志领先时仍展示保存内容，Run 状态可保持中断。输入尚未保存则只剩去重元数据，需要用户重新发送。恢复不构造另一份正文、不伪造旧 SSE。退出停止监听、取消活跃 Run、等执行结束、关闭 Harness/storage 与数据库、释放锁。

备份前停止 API，复制整个 PIKO_HOME 和单独指定的工作区，恢复保留工作区绝对路径。main 与 doc 日志必须成套备份。旧版测试改用新 PIKO_HOME，原数据保留。当前 UI 历史全量投影，分页加载/增量索引按规模再做。

## Telegram 通道

Telegram 与 RN 共用 ConversationStore、主 Thread 和 runtime。TG 收据与输入 Run 在同一 SQL 事务内预留；仅管理操作占用或执行正在停止时拒绝输入，拒绝决定也保持去重。轮询在持久化接纳成功后才确认 update。停止命令保存当时的目标输入，并在其仍活跃时停止 conversation，重投不能停止之后的任务。TG 的输出观察和输入接纳分开，同一助手消息 ID 复用同一投递对象，补充消息不会重新发送旧回复。

TG 模型/思考按钮与压缩复用运行时接口；HTTP/TG 管理操作先通过 ConversationStore 预留空闲边界，queued Run 和异步初始化也受互斥保护。按钮菜单仅在内存保存来源和目录快照，点击时再次鉴权及验证当前能力，不写另一套聊天正文。当前选择由 durable Agent 文档持久化，状态详情使用运行时安全元数据。

运行时按原生助手消息输出独立快照。RN 和 TG 都按消息 ID 更新当前条目，提交时将临时身份替换成原生 entry 身份，新助手消息另起一条。TG 保留流式 Rich Markdown 编辑；工具调用和自动压缩当前不展示。

TG 只投递自身发起的回复，命令提示不写入 Pi 历史；RN 展示两端聊天的原生投影。RN 前台空闲时每 3 秒发现变化，活跃 Run 使用既有 SSE。TG 网络发送与执行分离，平台消息 ID 不持久化，不承诺重启补发；共享主会话中断不自动执行。配置、命令、生命周期和边界见 [双通道说明](features/telegram-channel.md)。

## 后续方向（未实现）

持久化工具可以使用 `defineDoc` 保存结构化项目状态；后台执行可以使用 durable task definition、conversation 和 write submission。这些底层能力已可在插件使用，个人助理的任务调度、重启续跑策略、结果投递队列、卡片、通知与权限 UI 尚未实现。

未来摘要以被动 entry 进入主会话，在安全边界放置，不触发额外模型回复；SQL 只增加产品调度/去重元数据，不建立第二套结果正文库。后台任务的恢复策略须明确授权范围，不能直接套用主聊天中断策略。
