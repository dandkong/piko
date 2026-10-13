# Piko 架构约定

当前 Agent 底层为 pi-durable 1.1.0，模型适配为 pi-ai 1.1.0。体验见 [PRODUCT](PRODUCT.md)，进度见 [路线图](../ROADMAP.md)，配置见 [Durable 配置与插件](features/durable-runtime.md)。

## 当前结构

```text
Expo / React Native → HTTP + SSE ──┐
                                 ├── Bun 会话服务 → 运行时接口 → pi-durable → pi-ai
Telegram 私聊 → Bot API 适配器 ────┘
```

| 位置 | 职责 |
| --- | --- |
| apps/mobile/src/features/chat/ | 页面、输入、临时状态、会话 HTTP/SSE |
| apps/mobile/src/components/、theme.ts | 通用布局、头像、导航和视觉 |
| server/app.ts、http.ts | 路由、校验与 HTTP 响应 |
| server/index.ts、config.ts | 配置、初始化、单进程锁、监听与退出 |
| server/web.ts | 正式 Web 导出文件托管、路径边界、缓存与 SPA fallback |
| server/chat/ | 文本校验、接纳与管理操作互斥、会话观察和内存重放 |
| server/channels/telegram/ | 私聊身份、命令、轮询确认与回复呈现 |
| server/domain/ | 工作区初始化、路径校验与后端锁 |
| server/runtime/ | Durable/pi-ai 适配、配置、插件、资源与原生历史投影 |
| server/resources/ | 核心指导、内建技能与用户模板 |
| shared/ | 普通跨端契约，不依赖 Pi、Bun 或 React Native |
| tests/ | 协议、原生状态、并发、恢复、配置与通道验证 |

页面 → Hook/API → HTTP/SSE；路由/通道 → 会话业务 → 运行时接口 → Pi 适配器。SDK 类型留在 server/runtime，Telegram SDK 留在通道目录。Durable 是唯一 Agent 运行时和持久化来源；Piko 没有 SQLite、Workspace/Thread 表或 Run 状态副本，不引入 pi-server / pi-client。

正式 `bun run start` 由同一 Bun 监听提供 Web 静态文件、API/SSE 与可选 TG；静态根固定 apps/mobile/dist/web，缺少构建即拒绝启动。Web 默认同源 `/api`；Piko 不过滤 Origin，访问认证与安全边界由反向代理或网络负责。开发继续使用 Expo，正式启动与 Linux 模板见 [部署说明](features/linux-deployment.md)。

## 工作区与状态

一个 PIKO_HOME 对应一个 Harness 和固定 root conversation。工作区由应用配置指定；主会话的 cwd 存在原生 Agent 文档中。已有会话与配置工作区路径不一致时拒绝启动，避免上下文和工具目录错配；恢复原路径或使用新的 PIKO_HOME。后台委派在同一 Harness 内创建 owned 子 conversation，共用配置和资源，仅移除嵌套委派；用户 Side chat 交互尚未实现。详见 [后台子 Agent](features/background-subagents.md)。

默认目录在后端机器 `~/.piko`，独立于源码。`server/config.ts` 按默认值 < config/piko.json < config/.env < 进程环境合并、转换、校验后注入；PIKO_HOME 仅由进程环境定位。模型文件独立，不继承个人 Pi CLI。详细字段见 [应用配置](features/application-config.md)。

```text
~/.piko/
├── config/
│   ├── piko.json                 # HTTP、工作区、通道
│   ├── .env                      # 可选覆盖
│   ├── settings.json             # 模型预设、运行设置
│   ├── models.json               # 供应商与模型
│   └── auth.json                 # 模型凭据
├── extensions/                  # durable 插件
├── skills/                      # 用户公共技能
├── state/
│   ├── backend.lock             # 单后端写进程
│   ├── tmp/                     # 工具溢出、插件 bundle
│   └── durable/
│       ├── main.jsonl           # 会话、entries、任务、submissions
│       └── doc-*.jsonl          # 原生与插件文档
└── workspace/
    ├── AGENTS.md
    ├── MEMORY.md
    ├── .agents/skills/<name>/SKILL.md
    ├── memory/
    ├── projects/
    └── artifacts/
```

初始化只补缺失文件，保留用户内容，拒绝类型冲突与越界链接；state 必须在工作区外。当前使用固定 state/durable，不迁移旧 SQLite 或 durable-sessions 布局，也不读取其聊天历史。清理旧数据须先停止后端，配置和工作区不随数据库清理删除。

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

## 原生状态与历史投影

| 对象 | 来源与用途 |
| --- | --- |
| Workspace | 应用配置中的规范化路径；原生 Agent.cwd 关联工作区 |
| Conversation | Harness 的 root 和 owned 后台子会话；未来 side chat 复用原生关系 |
| Submission | 原生 requestId 去重；queued / placed / done / unanswered |
| Task、InboxDoc、LiveDoc | 原生执行、待应用输入和当前生成状态 |
| Message | 完整原始 entries 的展示投影，不另存正文 |
| piko.recovery | 原生文档记录重启中断提示，下一次接纳清除 |
| piko.stop | 按停止请求身份保存原目标 task ID；原生文档，不复制执行状态 |
| piko.input-origin / piko.subagent-control | 原生文档保存通道/内部来源与取消 epoch、已报告回答 ID；不复制执行状态或正文 |
| StreamEvent | 当前进程 epoch、递增 sequence；最多 128 条内存重放 |

原生 ID 由 Durable 分配；跨端按不透明字符串传输。RN 输入和停止请求使用 UUID，TG 输入使用 telegram:<botId>:<chatId>:<messageId>。网络重投保留原 requestId；用户主动重试是新请求，不强制原文或失败关联，不再维护输入哈希或 piko.input 标记。相同 requestId 返回原生提交，调用方不能用它表达新内容。

历史在同一次原生 commit 内分页读取完整 entries、submission 绑定和状态，按 entry ID 投影；不能使用压缩后的 conversation.context() 作为 UI 历史。用户/助手文本 ID 为 pi-<entry ID>，时间来自原生消息；工具、思考、隐藏标记和摘要不形成气泡。display=true 的 piko.result 可投影为被动回复，产品投递入口尚未实现。

生成中使用临时消息身份，保存后原位替换为原生身份。快照包含已保存历史、当前未提交文字和原生 inbox 中待应用输入；临时投影不落盘。输入与助手消息各自展示，不分组、不强行配对，压缩和 reset 不删除原始展示历史。

## API 与执行

| 接口 | 行为 |
| --- | --- |
| GET /api/chat | 共享主会话完整消息和 busy、latest、interruption 状态 |
| POST /api/chat | {requestId,message}，返回 {submission,duplicate}；不返回 SSE |
| GET /api/chat/events?epoch=…&after=N | 独立、持续的会话 SSE，空闲时保持连接 |
| GET /api/chat/submission?requestId=… | 查询原生提交回执；不存在返回 404 |
| POST /api/chat/stop | {requestId}，停止当前 conversation，重复请求只处理原目标 |
| GET /api/health | 后端和模型可用状态 |
| GET /api/runtime | 模型、思考、预设、技能与插件安全元数据 |
| POST /api/runtime/selection、compact、cancel | 模型选择、压缩和停止；选择/压缩要求空闲 |

不通过客户端 ID 创建会话，不提供主会话删除、旧 /api/main 或按 Run 观察接口。

接纳串行，模型工作不占用接纳锁。RN/TG 普通输入统一使用 whenBusy=steer、steeringMode=all，在原生接纳边界一起加入当前工作，不打断已经开始的模型请求或工具。管理操作预留空闲边界；期间立即拒绝普通输入，停止仍能取消压缩。拒绝输入不创建 submission，也不永久保存拒绝决定。

停止撤回未应用输入，取消当前原生任务作用域。停止请求在原生事务内记录当时非 background 的任务并撤回当时 inbox，随后取消这些任务；重投只操作原 ID，不误停新工作。执行失败将剩余输入结算为 unanswered 并保留失败原因，再收尾当前作用域；不自动执行尚未应用的补充。Durable 自身配置允许的模型重试仍由运行时处理。

原生 storage 使用 fsync:true，提交和文档协议由 Durable 管理，不再双写 SQL 或另发 Piko 执行终态。watchEvents 将消息、条目和执行变化转换为普通跨端事件；SDK 事件不直接进入 UI。消息更新最多 50ms 合并，状态变化发送完整 snapshot；积压时从原始 entries 校正。工具、思考和自动压缩的展示尚未接入。

SSE 用进程 epoch 和 sequence 重放；缓存过期、重启或未知游标直接发送新 snapshot，客户端接受新 epoch。15 秒心跳，客户端 30 秒无数据重连，退避最多 10 秒。断线和退后台只退订，不停止执行；回前台重新观察完整会话，不重发输入。RN 根据观察版本丢弃过期 HTTP 刷新，保留草稿及未确认输入。

## 恢复、退出与备份

启动先取得锁、打开固定原生存储、校验 root/cwd，再接收 HTTP/TG。完整损坏记录或剩余 doc 日志缺少 main.jsonl 时拒绝继续；Durable 原生处理残尾及 sidecar 恢复。整个目录被移除视为新会话，无另一个数据库可恢复正文。

启用调度前撤回遗留输入并用原生 abortTask 取消不确定执行；保留已经完成回答的 Reporter report 阶段，随后 resume 回传结果，不重放主/子模型或工具执行。有遗留生成或输入时，将中断提示存入 piko.recovery 并添加隐藏上下文说明，不触发模型；已保存历史继续展示。尚未保存的流式文字不承诺恢复，不回滚外部工具副作用。

退出停止接纳和 polling，取消主会话当前非 background 工作、有界收尾 TG 投递，关闭订阅、Harness/storage 并释放锁。备份前停止 API，复制整个 PIKO_HOME 和单独指定的工作区；main 与 doc 日志成套保存，恢复保留工作区绝对路径。当前 UI 全量历史读取，增量加载按规模再开发。

## Telegram 通道

TG 与 RN 共用 ConversationStore 和 root。后台结果以可信内部 follow-up 唤起主 Agent；UI 不显示报告或子会话，只显示主 Agent 实际回复。TG 来源可重新开启投递观察，RN 来源不额外推 TG。鉴权通过后，以 Bot/chat/message 稳定身份提交原生输入；持久化接纳成功才确认 polling update，重复输入不再执行或重发回复。模型/思考按钮与压缩复用空闲预留和运行时接口，命令反馈不进入模型历史。

RN 持续观察会话；TG 投递只在经过验证的输入私聊启用。每条助手消息有独立 Rich Markdown 消息，条内流式编辑；补充输入不重发旧回复。TG 加入 RN 正在执行的工作只观察未完成及后续消息，纯 RN 工作默认不推送 TG。平台发送状态在内存，不承诺重启补发；失败不改变原生执行状态。详细命令、配置与限制见 [双通道说明](features/telegram-channel.md)。

## 后续方向（未实现）

Side chat、产品调度、通知、权限与可靠 outbox 尚未实现。结构化项目状态优先复用原生 defineDoc，后台工作复用 task、conversation 和 write/input submission；先确定停止范围、上下文共享和恢复授权，不再引入重复执行状态或正文存储。
