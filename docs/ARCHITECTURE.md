# Piko 架构约定

当前 Agent 底层为 pi-durable 1.0.4，模型适配为 pi-ai 1.0.4。体验见 [PRODUCT](PRODUCT.md)，进度见 [路线图](../ROADMAP.md)，用法见 [Durable 配置与插件](features/durable-runtime.md)。

## 当前结构

```text
Expo / React Native → HTTP + SSE → Bun Chat 服务
                                     ↓ 运行时接口
                              pi-durable Harness
                                     ↓
                                    pi-ai
```

| 位置 | 职责 |
| --- | --- |
| apps/mobile/src/features/chat/ | 页面、输入、临时状态、主会话发现、HTTP/SSE |
| apps/mobile/src/components/、theme.ts | 通用布局、头像、导航和视觉 |
| server/app.ts、http.ts | 路由、校验、响应与 CORS；导入不监听端口 |
| server/index.ts、config.ts | 初始化、监听、单进程锁与退出清理 |
| server/chat/ | Run 生命周期、去重、取消、内存快照与事件重放 |
| server/domain/ | 工作区初始化、SQLite 身份/执行元数据、重启标记中断 |
| server/runtime/ | Durable/pi-ai 适配、JSON 配置、插件、资源范围、完整历史投影 |
| server/resources/ | 原有核心指导、内建技能、用户文件模板 |
| shared/ | 普通跨端类型与 SSE 契约，不依赖 Pi、Bun 或 React Native |
| tests/ | UI 逻辑、协议、API、并发、原生持久化、恢复、资源与插件验证 |

依赖方向：页面 → Hook/API → HTTP/SSE；路由 → 会话业务 → 运行时接口 → Pi 适配器。SDK 类型集中在 server/runtime；测试使用临时目录、faux provider 或本机模拟模型服务，不读取个人凭据。

Durable 是唯一 Agent 运行时和唯一会话内容存储。Piko 管理产品、工作区/Thread 关系、Run 生命周期和传输；不复制第二套消息正文或永久 SSE 日志，不引入 pi-server / pi-client。

## 工作区与状态

默认根目录为后端机器上的 `~/.piko`，独立于源码。`PIKO_HOME` 修改根目录，`PIKO_WORKSPACE` 可单独指定工作区，均要求绝对路径。

```text
~/.piko/
├── config/
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
    ├── AGENTS.md                   # 工作指导；AGENTS.override.md 存在时优先
    ├── SOUL.md                     # 人格与语气
    ├── USER.md                     # 用户偏好
    ├── MEMORY.md                   # 精简长期记忆
    ├── .agents/skills/<name>/SKILL.md
    ├── memory/
    ├── projects/
    └── artifacts/
```

初始化只补缺失文件，保留用户内容，拒绝工作区类型冲突与越界链接。state 必须在工作区外。当前 SQLite schema 为 3；不兼容旧 coding-agent 会话，不迁移或删除旧数据。配置不继承 `~/.pi/agent`。

## 模型、资源与插件

pi-ai 内建供应商目录配合 Piko FileCredentialStore；自定义 JSON 可指定 API、地址、模型能力、请求参数、headers 和适配兼容项。预设映射 provider/model/thinking；当前选择保存到 durable Agent 文档，重启保留。JSON 默认预设用于初始选择，修改默认预设不会覆盖会话已有选择。

配置重载先解析模型、验证当前选择、编译并注册候选插件，再关闭和重新打开原生 Harness；失败保留旧配置，重新打开失败则回退旧 registry。重载和选择期间占用会话空闲边界，不与生成并发。普通指导与技能索引在每次模型请求时刷新，无需重开 Harness。

- 技能优先级：工作区 `.agents/skills` > `PIKO_HOME/skills` > 应用 `server/resources/skills`。同名覆盖有诊断，非法 YAML 跳过。
- 核心指导保留在 `server/resources/prompts/core.md`；工作区 AGENTS/override 上限 8,000 字节，SOUL/USER/MEMORY 各 4,000 字节。注明来源，超量截断。技能只注入索引，正文按需 read。
- 显式资源范围，不发现祖先指导或个人 CLI 资源；UI 输入按原文处理，不展开 CLI 的 `/skill:` 命令。
- 插件从 `PIKO_HOME/extensions/*.ts|js|mjs` 或子目录 `index.ts|js|mjs` 加载，default export 为 durable Extension。支持 tools、sections、hooks、wraps、tasks，以及插件工具内使用原生持久化 doc。
- 插件使用 Bun 临时 bundle 刷新传递依赖，与宿主共享 Pi/Chord/TypeBox；外部依赖从插件目录解析。插件属于可信本机代码；不适配旧 CLI 扩展 UI/lifecycle API。
- read、write、edit、bash 使用 durable CodingTools，cwd 为工作区，临时输出在 state/tmp。本机权限与 cwd 不构成沙箱；目前没有单独操作审批 UI。
- 自动压缩、有限重试和手动压缩使用 durable 原生能力。1.0.4 的 read 暂不支持图片，工具进度、思考和产物专用 UI 尚未实现。

## 领域与历史投影

| 对象 | 当前职责 |
| --- | --- |
| Workspace | SQLite 保存稳定 UUID、规范化路径、创建时间 |
| Thread | main / side 类型；唯一 main，side 只预留 parentThreadId；原生会话引用 |
| Message | 指定 conversation 的完整原始 entries 临时投影；没有消息表 |
| Run | SQL 保存顺序、状态、输入 SHA-256、时间、重试来源、错误、状态游标；不保存正文 |
| StreamEvent | delta、replace、终态；最多 2,048 条内存重放 |
| Task / Artifact（后续） | 产品任务调度与产物管理；成果文件在工作区 |

实体 ID 为 UUID，时间为 Unix 毫秒数。每个 Thread 使用一个 durable session 目录与 root conversation。SQL 引用 `{version:2,directory:<thread UUID>,conversationId:<root ID>}`，不保存 leaf 或模型上下文快照。

历史在原生 Session 的事务内分页读取指定 conversation 的所有 entries，按 ID 正序投影，不使用压缩后的 `conversation.context()` 作为 UI 历史。用户/助手文本形成气泡，ID 为 `pi-<entry ID>`、时间来自原生 model message；隐藏内部标记、工具、思考、压缩摘要。`piko.result` 的 display=true 可形成被动结果气泡；目前没有产品投递入口。

`piko.run` state-only entry 只记录 runId/createdAt，关联随后输入及多条助手消息。执行中统一聚合本轮文本，避免已保存片段与 SSE 重复；最终重新读取原生权威历史。上下文编辑、reset 和压缩不删除 UI 原始消息。

## API 与执行

- GET `/api/main`：主 Workspace/Thread，sessionId 等于 Thread UUID。
- POST `/api/chat`：sessionId、runId、message、after?、retryOfRunId?；返回 SSE。
- GET `/api/sessions/:id`：完整原生历史、最近 Run 快照。
- GET `/api/sessions/:id/runs/:runId/events?after=N`：内存事件重放；过期/越界/重启后返回 409，客户端加载快照。
- POST `/api/sessions/:id/runs/:runId/cancel`：独立停止；断开观察连接只退订。
- GET `/api/runtime`：模型能力、选择、预设、技能、插件元数据；不返回凭据。
- POST `/api/runtime/selection|reload|compact|cancel`：模型选择、重载、手动压缩与停止；配置管理 UI 未实现。
- 不允许删除主会话或通过任意客户端 UUID 创建会话。

同 Thread 只允许一个活跃 Run，SQL 唯一约束保证。先预留身份/输入哈希，再调用 durable submit，requestId 为 run.id；重复身份和相同输入复用，不同输入拒绝。显式重试使用新 UUID、相同输入、失败 Run 引用。

queued → running → succeeded / failed；停止经过 cancelling → cancelled。终态先 fsync 原生 main 事务日志，再写 SQL 元数据，再发布终态；原生 storage 启用 fsync，doc 日志由其提交协议管理。存储失败阻止成功发布，并停止后续提交。流式文本最多 50 毫秒合并，不落盘；retry 导致文本修正时发送 replace，客户端整体替换。

SSE 15 秒心跳，客户端 45 秒无数据恢复并有限退避。观察者断线不取消任务，回前台加载快照。正在运行的快照与重放在内存中，重启不承诺恢复未保存片段。

## 恢复、退出与备份

启动用原生 JSONL storage 校验主会话，不启用任务调度。已引用日志缺失、目录身份不符、完整记录损坏拒绝继续。durable 原生恢复截断末尾半条记录、处理未确认 sidecar 事务；Piko 不再维护旧格式解析器或 `.torn-*` 归档。

SQL 遗留活跃 Run 标记 failed + interrupted。第一次打开 Harness 时，在启用普通生成前调用 `abort({background:true})` 撤销遗留作用域工作，避免工具/模型自动重放。中断说明以隐藏原生 entry 写入上下文，原生 doc 按 runId 去重，不重复输入、不触发回复。Piko 明确保持用户再次提交后才执行的产品语义。

原生日志与 SQL 不构成跨存储事务：日志领先时仍展示保存内容，Run 状态可保持中断。输入尚未保存则只剩去重元数据，需要用户重新发送。恢复不构造另一份正文、不伪造旧 SSE。退出停止监听、取消活跃 Run、等执行结束、关闭 Harness/storage 与数据库、释放锁。

备份前停止 API，复制整个 PIKO_HOME 和单独指定的工作区，恢复保留工作区绝对路径。main 与 doc 日志必须成套备份。旧版测试改用新 PIKO_HOME，原数据保留。当前 UI 历史全量投影，分页加载/增量索引按规模再做。

## 后续方向（未实现）

持久化工具可以使用 `defineDoc` 保存结构化项目状态；后台执行可以使用 durable task definition、conversation 和 write submission。这些底层能力已可在插件使用，个人助理的任务调度、重启续跑策略、结果投递队列、卡片、通知与权限 UI 尚未实现。

未来摘要以被动 entry 进入主会话，在安全边界放置，不触发额外模型回复；SQL 只增加产品调度/去重元数据，不建立第二套结果正文库。后台任务的恢复策略须明确授权范围，不能直接套用主聊天中断策略。
