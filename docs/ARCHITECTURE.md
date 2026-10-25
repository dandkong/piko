# Piko 架构约定

当前 Agent 底层为 pi-durable 1.3.0，模型适配为 pi-ai 1.3.0。体验见 [PRODUCT](PRODUCT.md)，进度见 [路线图](../ROADMAP.md)，配置见 [Durable 配置与运行时](features/durable-runtime.md)。

## 当前结构

```text
Expo / React Native → HTTP + SSE ──┐
                                 ├── Bun 会话服务 → 运行时接口 → pi-durable → pi-ai
Telegram 私聊 → Bot API 适配器 ────┘
```

| 位置 | 职责 |
| --- | --- |
| apps/mobile/src/features/chat/ | 页面、输入、临时状态、会话 HTTP/SSE |
| apps/mobile/src/components/、theme.ts | 通用控件和视觉常量；业务 Shell、头像与导航在 features/shell/ |
| apps/mobile/src/features/shell/ | 应用唯一 Shell、抽屉动画和聊天滚动层；各聊天保留独立 state owner 和滚动视图 |
| server/app.ts、http.ts | URL 分发、CORS、错误响应与有界请求读取；具体校验留在各功能 HTTP handler |
| server/index.ts、config.ts | 配置、初始化、单进程锁、监听与退出 |
| server/web.ts | 正式 Web 导出文件托管、路径边界、缓存与 SPA fallback |
| server/chat/ | 文本校验、会话观察与输出合并；不重复管理运行时互斥或后台结果缓存 |
| server/channels/telegram/ | 私聊身份、命令、轮询确认与回复呈现 |
| server/workspace.ts、task-files.ts、domain/lock.ts | 工作区初始化、任务文件目录边界与后端锁；文件 I/O 不混入任务定义校验 |
| server/runtime/pi.ts、bootstrap.ts | 唯一 Harness/服务所有者；启动恢复和策略重配先完成，再 resume |
| server/runtime/conversation-*.ts | session facade、control 接纳线、view 历史/事件投影、固定原生文档，分别负责独立职责 |
| server/tools/ | 不依赖 Agent SDK 的联网请求、搜索与正文提取 |
| server/chat/http.ts、side-chats/http.ts、tasks/http.ts、attachments/http.ts | 分功能 HTTP 输入校验与业务调用 |
| server/domain/tasks.ts | 纯任务定义校验和日历规则；业务类型 AssistantTask |
| server/runtime/subagents/ | 共用执行、原生事实查询、固定文档、恢复和薄工具入口 |
| server/runtime/tasks/ | 任务定义、游标、命令幂等、调度及按需执行查询；依赖共用执行，不依赖普通委派工具 |
| server/runtime/side-chat-service.ts、side-chats.ts | 旁聊业务规则与原生元数据/查询，运行时提供会话接纳和生命周期 |
| server/resources/ | 核心指导、内建技能与用户模板 |
| shared/ | 普通跨端契约，不依赖 Pi、Bun 或 React Native |

页面 → Hook/API → HTTP/SSE；路由/通道 → 会话业务 → 运行时接口 → Pi 适配器。SDK 类型留在 server/runtime，Telegram SDK 留在通道目录。Durable 是唯一 Agent 运行时和持久化来源；Piko 没有 SQLite、Workspace/Thread 表或 Run 状态副本，不引入 pi-server / pi-client。

正式 `bun run start` 由同一 Bun 监听提供 Web 静态文件、API/SSE 与可选 TG；静态根固定 apps/mobile/dist/web，缺少构建即拒绝启动。Web 默认同源 `/api`；Piko 不过滤 Origin，访问认证与安全边界由反向代理或网络负责。开发继续使用 Expo，正式启动与 Linux 模板见 [部署说明](features/linux-deployment.md)。

## 工作区与状态

一个 PIKO_HOME 对应一个 Harness 和固定 root conversation。工作区由应用配置指定；主会话的 cwd 存在原生 Agent 文档中。已有会话与配置工作区路径不一致时拒绝启动，避免上下文和工具目录错配；恢复原路径或使用新的 PIKO_HOME。后台委派在同一 Harness 内创建 owned 子 conversation，共用配置与全局资源，移除嵌套委派和任务管理；任务执行在 items/<id> 下使用独立 cwd 和本任务记忆，见 [任务与执行记录](features/tasks.md)。每日/长期记忆由独立的内部 记忆整理 task 处理，不展示为 Tasks 任务；旁聊使用独立 ownerless conversation，共享记忆/技能/通用工具，不继承主聊天上下文、不自动回传、不提取旁聊记忆、不开放任务管理工具；旁聊委派仅作用于 owner conversation；见 [旁聊](features/side-chats.md)。详见 [后台子 Agent](features/background-subagents.md) 和 [记忆整理](features/workspace-and-main-chat.md#每日与长期记忆整理)。

默认目录在后端机器 ~/.piko，独立于源码。server/config.ts 严格按字段分工：piko.json 管应用/Agent/工具行为，models.json/auth.json 管模型目录和凭据；环境管理部署参数、通道和工具凭据，没有同一字段的双入口。仅环境体系内部 config/.env < 进程环境，PIKO_HOME 由进程定位；放错位置报错。模型文件独立，不继承个人 Pi CLI，见 [应用配置](features/application-config.md)。

```text
~/.piko/
├── config/
│   ├── piko.json                 # agent 预设/连接选项、通道、工具行为
│   ├── .env                      # 私有部署参数、通道/工具凭据，0600
│   ├── models.json               # 供应商/模型配置、可选 provider apiKey 和 headersEnv
│   └── auth.json                 # Pi 格式模型 API Key / OAuth 凭据，优先于 provider apiKey
├── state/
│   ├── backend.lock             # 单后端写进程
│   ├── tmp/                     # 工具溢出与临时文件
│   └── durable/
│       └── session.sqlite      # Durable 原生会话、entries、任务、submissions、文档（运行期另有 WAL/SHM）
└── workspace/
    ├── AGENTS.md
    ├── MEMORY.md
    ├── .agents/skills/<name>/SKILL.md
    ├── memory/
    ├── projects/
    ├── artifacts/
    └── items/<id>/
        └── MEMORY.md              # 任务总览；执行产物直接写在同一目录
```

初始化只补缺失文件，保留用户内容，拒绝类型冲突与越界链接；state 必须在工作区外。当前源码使用固定 state/durable/session.sqlite；当前 Durable JSONL 须按 [SQLite 存储](features/sqlite-storage.md) 显式离线迁移，更旧的 Piko 自建 SQLite 或 durable-sessions 不由此脚本导入。清理旧数据须先停止后端，配置和工作区不随数据库清理删除。

## 模型、资源与内建扩展

模型凭据通过 StoredCredentialStore 从 config/auth.json 只读加载，其次使用 models.json 的 provider apiKey；不回退进程环境变量。通道、工具和显式 headersEnv 仍从后端环境读取。model-config.ts 负责加载和角色校验，model-provider.ts 负责供应商目录、请求选项和 stream 适配。自定义 JSON 可指定 API、地址、模型能力、请求参数及兼容项。当前模型选择保存到 durable Agent 文档，重启保留。agent.profiles 只有 main 和 background 两个固定角色位：main 用于初始选择且不覆盖会话已有选择，background 单独决定后台子 Agent 的模型，未配置时继承发起会话的选择。

Agent 预设统一在 piko.json.agent，取消 settings.json 的生成/读取；retry/compaction 不作为 Piko 配置或默认文件字段，直接使用 Durable 默认策略。可选 agent.stream 保留模型连接选项，不是 Harness 重试策略。

模型配置在创建原生 Harness 时加载，修改后重启后端生效；不提供运行时重载接口。Durable Extension 由 Piko 服务端源码注册，不加载 `PIKO_HOME` 或工作区中的代码插件。模型/思考选择及压缩占用会话空闲边界，不与生成并发。普通指导与技能索引在每次模型请求时刷新，无需重开 Harness。

- 技能来源：工作区 `.agents/skills/<目录>/SKILL.md` 与应用 `server/resources/skills/<目录>/SKILL.md`，只读单层，不递归或跟随链接目录/文件；同名时工作区优先。同名覆盖有诊断，非法 YAML 跳过。`PIKO_HOME/skills` 不创建也不读取。
- 核心指导 `server/resources/prompts/core.md` 负责运行规则；工作区只加载 AGENTS.md（助手身份、表达和做事约定）与 MEMORY.md（用户资料、环境事实和长期结论）。`memory/YYYY-MM-DD.md` 每日记忆不自动注入，相关时由助手按需 read/search。注入时标注来源和角色，文件职责见 [资源与工具](features/workspace-and-main-chat.md#资源与工具)；角色标注不是权限隔离。core、AGENTS、全局和任务 MEMORY 均完整读取，不设应用层文本上限，不静默截断；实际请求仍受模型上下文窗口限制；过大的静态指导可能导致请求在自动压缩聊天历史后仍被模型拒绝，不静默截断文件。技能只注入索引，正文按需 read。
- 显式资源范围，不发现祖先指导或个人 CLI 资源；UI 输入按原文处理，不展开 CLI 的 `/skill:` 命令。
- Durable Extension 仅用于 Piko 内建能力：资源 section、web 工具、子 Agent 和内部 记忆整理 task。记忆整理 task 仅在主会话闲置 30 分钟后创建专用子会话，限配 `read/write/edit`，从同一批增量直接维护每日及长期记忆；无主 Agent 手动触发工具。子会话的 Bash 使用工作区 cwd 但不是安全沙箱。用户自定义行为通过 skill 指导助手调用已有工具；skill 不注册新工具或运行时 hooks。
- read、write、edit、bash 使用 durable CodingTools，cwd 为工作区，临时输出在 state/tmp。`read` 对 PNG/JPEG/GIF/WebP/BMP 返回图片块，Photon 处理器在 worker 中做方向校正、转码和缩放；非视觉模型由上游给占位诊断。收发的附件（任意文件）落在 `PIKO_HOME/state/attachments`，Piko 只负责接收和给出路径，类型判断交给模型；见 [附件与图片读取](features/attachments.md)。本机权限与 cwd 不构成沙箱；目前没有单独操作审批 UI。
- web_search/web_extract 由内置 piko-web 注册，网络业务与 SDK 适配分离。搜索的 query/maxResults/freshness/includeDomains/excludeDomains 不暴露供应商；启用开关与 providers 优先级只在 piko.json，搜索凭据 EXA_API_KEY/TAVILY_API_KEY/DEEPSEEK_SEARCH_API_KEY/BRAVE_SEARCH_API_KEY 在创建 Harness 时从后端环境读取，不进入客户端或工具记录。未配置不阻止其他能力。tools 元数据报告内建工具与配置状态；技能/脚本不自动成为内置能力。见 [网络工具](features/web-tools.md)。
- 自动压缩、有限重试和手动压缩使用 durable 原生能力。图片读取已接入；工具进度、思考和产物专用 UI 尚未实现。

## 原生状态与历史投影

| 对象 | 来源与用途 |
| --- | --- |
| Workspace | 应用配置中的规范化路径；原生 Agent.cwd 关联工作区 |
| Conversation | Harness 的 root、ownerless 用户旁聊与 owned 后台子会话 |
| Submission | 原生 requestId 去重；queued / placed / done / unanswered |
| Task、InboxDoc、LiveDoc | 原生执行、待应用输入和当前生成状态 |
| Message | 完整原始 entries 的展示投影，不另存正文 |
| piko.recovery | 原生文档记录重启中断提示，下一次接纳清除 |
| piko.stop | 按停止请求身份保存原目标 task ID；原生文档，不复制执行状态 |
| piko.input-origin / piko.subagent-control | 原生文档保存通道/内部来源与取消 epoch、已报告回答 ID；不复制执行状态或正文 |
| piko.work-items / piko.item-command / piko.item-context | 固定持久化身份不随 AssistantTask 符号改名；保存定义、游标、回执与归属，状态从原生 Reporter/submission/LiveDoc 投影，不是新旧兼容层 |
| piko.memory-curation | 原生文档保存 root 历史游标、闲置时间、活动 整理 task 与重试状态；记忆正文仅保存在工作区 Markdown 文件 |
| piko.side-chat / piko.side-chat-creates | 旁聊名称/创建/归档元数据与创建请求回执，不复制聊天或执行状态 |
| StreamEvent | 按会话隔离的当前快照与实时更新；不保存事件重放缓存或传输游标 |

原生 ID 由 Durable 分配；跨端按不透明字符串传输。RN 输入和停止请求使用 UUID，TG 输入使用 telegram:<botId>:<chatId>:<messageId>。网络重投保留原 requestId；用户主动重试是新请求，不强制原文或失败关联，不再维护输入哈希或 piko.input 标记。相同 requestId 返回原生提交，调用方不能用它表达新内容。

历史在原生 commit 线上按不可变 entry ID 游标读取原始 entries 并投影；最近快照和向前分页每页至多 50 条可见已保存消息，提交绑定从原生 submission 初始化并随 commit 更新。不能使用压缩后的 conversation.context() 作为 UI 历史。用户/助手文本 ID 为 pi-<entry ID>，时间来自原生消息；工具、思考、隐藏标记和摘要不形成气泡。只投影原生用户/助手消息，不为尚无写入端的被动结果预留展示分支。

生成中使用临时消息身份，保存后原位替换为原生身份。快照包含已保存历史、当前未提交文字和原生 inbox 中待应用输入；临时投影不落盘。输入与助手消息各自展示，不分组、不强行配对，压缩和 reset 不删除原始展示历史。

## API 与执行

| 接口 | 行为 |
| --- | --- |
| GET /api/chat | 共享主会话最近 50 条已保存消息、流式/排队消息、向前游标和 busy、latest、interruption 状态 |
| GET /api/chat/history?before=… | 根据 entry ID 向前加载至多 50 条可见历史，返回 nextBefore |
| POST /api/chat | {requestId,message}，返回 {submission,duplicate}；不返回 SSE |
| GET /api/chat/events | 每次连接先发最新快照，随后持续观察，空闲时保持连接 |
| POST /api/chat/stop | {requestId}，停止当前 conversation，重复请求只处理原目标 |
| GET /api/health | 后端和模型可用状态 |

原生会话 ID 由 Durable 分配，不由客户端提供；不提供主会话删除、旧 /api/main 或按 Run 观察接口。闲置的 runtime HTTP 管理与独立 submission 查询入口已移除；模型选择/压缩仍供 TG 直接调用，去重及后台报告仍使用原生回执，客户端从 POST 与快照恢复接纳状态。旁聊元数据使用 `/api/side-chats`，聊天链路使用 `/api/side-chats/:id/chat`，复用主会话的快照、分页、SSE、提交回执和停止语义；详见 [旁聊 API](features/side-chats.md#http)。

每个 DurableChatSession 只绑定一个 Conversation，作为 facade 将输入、停止、维护、完整归档及内部报告提交交给 ConversationControl 的同一接纳线；历史/流式快照由 ConversationView 投影。内部报告不得绕过控制器直接提交；归档期间持有预留，报告进入时重新检查可写与取消 epoch。ConversationStore 只转发、合并和关闭观察，不停止或销毁控制器；runtime 唯一拥有其生命周期。根会话的通道回报提示由独立 BackgroundReplies 保存在内存，不属于执行状态或可靠 outbox。运行时接口的描述、配置、压缩、停止与关闭都是必需能力。模型工作不占用接纳锁。RN/TG 普通输入统一使用 whenBusy=steer、steeringMode=all，在原生接纳边界一起加入当前工作，不打断已经开始的模型请求或工具。管理操作预留空闲边界；期间立即拒绝普通输入，停止仍能取消压缩。拒绝输入不创建 submission，也不永久保存拒绝决定。

停止撤回未应用输入，取消当前原生任务作用域。停止请求在原生事务内记录当时非 background 的任务并撤回当时 inbox，随后取消这些任务；重投只操作原 ID，不误停新工作。执行失败将剩余输入结算为 unanswered 并保留失败原因，再收尾当前作用域；不自动执行尚未应用的补充。Durable 自身配置允许的模型重试仍由运行时处理。

原生 storage 使用 fsync:true，提交和文档协议由 Durable 管理，不再双写 SQL 或另发 Piko 执行终态。watchEvents 将消息、条目和执行变化转换为普通跨端事件；SDK 事件不直接进入 UI。消息更新最多 50ms 合并，状态变化发送最近一页 snapshot；积压时从原始 entries 校正。Web 不展示工具或思考；Telegram 临时展示每个执行中的工具，并独立订阅手动/阈值/溢出压缩的开始与终态，不把通知写入聊天历史。

SSE 每次建立连接都先发送最近一页的 authoritative snapshot，再接收实时更新；不维护 epoch/sequence、游标或事件重放缓存，不补齐断线期间的中间流式事件。快照与实时订阅仍在同一发布线上衔接，避免漏掉连接期间的变化。15 秒心跳，客户端 30 秒无数据重连，退避最多 10 秒。断线和退后台只退订，不停止执行；回前台重新观察最近窗口，不重发输入；客户端保留已经加载的连续历史，无交集时回到最新页避免掩盖缺口。RN 根据观察版本丢弃过期 HTTP 刷新，保留草稿及未确认输入。

## 恢复、退出与备份

启动先取得锁、打开固定原生存储、校验 root/cwd，再接收 HTTP/TG。数据库损坏、目录仍含旧 JSONL 或非空目录缺少 session.sqlite 时拒绝继续；SQLite 原生处理 WAL 事务恢复。整个目录被移除视为新会话，无另一个数据库可恢复正文。

启用调度前撤回遗留输入并用原生 abortTask 取消不确定执行；保留已经完成回答的 Reporter report 阶段，随后 resume 回传结果，不重放主/子模型或工具执行。有遗留生成或输入时，将中断提示存入 piko.recovery 并添加隐藏上下文说明，不触发模型；已保存历史继续展示。尚未保存的流式文字不承诺恢复，不回滚外部工具副作用。

退出停止接纳和 polling，先分离输出观察并有界收尾 TG 投递，再由运行时停止各聊天控制器与维护操作，最后关闭 Harness/storage 并释放锁。备份前停止 API，复制整个 PIKO_HOME 和单独指定的工作区；main 与 doc 日志成套保存，恢复保留工作区绝对路径。UI 默认最近一页，向上滚动加载更早历史；运行时仍保留完整原生 entries 用于恢复，分页不使启动/运行时内存变为常量。

## Telegram 通道

TG 与 RN 共用 ConversationStore 和 root。后台结果以可信内部 follow-up 唤起主 Agent；UI 不显示报告或子会话，只显示主 Agent 实际回复。普通子 Agent 只回复来源通道（RN 来源不推 TG）；保存任务的执行结果推送到所有通道。App 是聚合视图，始终能看到全部记录。鉴权通过后，以 Bot/chat/message 稳定身份提交原生输入；polling update 的确认由 grammY 默认轮询管理，不与持久化接纳严格绑定；重复已接纳输入不再执行或重发回复。模型/思考按钮与压缩复用空闲预留和运行时接口，命令反馈不进入模型历史。

RN 持续观察会话；TG 投递只在经过验证的输入私聊启用。每条助手消息有独立 Rich Markdown 消息，条内流式编辑；补充输入不重发旧回复。TG 加入 RN 正在执行的工作只观察未完成及后续消息，纯 RN 工作默认不推送 TG。平台发送状态在内存，不承诺重启补发；失败不改变原生执行状态。详细命令、配置与限制见 [双通道说明](features/telegram-channel.md)。

结构边界、查询读取范围及回归清单见 [中期运行时重构](features/runtime-refactor.md)。

## 后续方向（未实现）

任务调度与 Tasks 首版已接入：一个 Prompt、一条可选时间规则、一个目录，结果交回主 Agent；详见 [任务与执行记录](features/tasks.md)。旁聊首版已接入，见 [旁聊](features/side-chats.md)；独立通知、权限与可靠 outbox 尚未实现。结构化项目状态优先复用原生 defineDoc，后台工作复用 task、conversation 和 write/input submission；先确定停止范围、上下文共享和恢复授权，不再引入重复执行状态或正文存储。
