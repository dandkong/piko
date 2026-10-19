# Piko 开发路线图

当前是具备持久主会话的文本聊天原型。已完成 UI、基本流式交互，以及工作区和聊天持久化首个增量。产品方向见 [PRODUCT](docs/PRODUCT.md)，技术约定见 [ARCHITECTURE](docs/ARCHITECTURE.md)。

## 当前基线

- Expo / React Native 覆盖 Web、iOS、Android；已打磨聊天布局、输入、滚动与等待动效，并增加根目录 Android 原生启动命令。
- 助手消息支持 Markdown 与流式未闭合语法显示，代码块和表格支持横向滚动；用户消息保持原文。
- Bun 托管 pi-durable 1.1.0 + pi-ai 1.1.0，使用 HTTP + SSE 提供文本流、停止、错误重试、提交去重、快照、断线/刷新/前台恢复。
- 服务端唯一主会话，Durable 原生 JSONL 是唯一会话内容来源；UI 投影完整 conversation entries，Piko 不使用 SQLite 或 Run；原生 submission/inbox/live 管理去重和执行，重启撤销遗留工作并显示中断提示，流式片段不另行持久化。
- 工作区初始化、有限指导/技能发现与 Pi 的 read、write、edit、bash 四个内建工具已启用；可读取/创建工作区技能和执行脚本，不加载用户代码插件。
- 内置 web_search/web_extract 已接入；搜索保持 query/maxResults 参数，凭据从后端环境读取，不向模型暴露供应商；正文提取沿用 Readability/Markdown，支持超时与停止。运行时清单报告内建工具与配置状态，工作区技能/脚本不注册新工具。[网络工具](docs/features/web-tools.md)。
- 非敏感 JSON 模型/预设配置与环境凭据严格分离，思考强度及选择/压缩/取消 API 已接入；TG 增加模型/思考按钮菜单、压缩与详细状态，共享主会话选择和空闲限制。[配置说明](docs/features/durable-runtime.md)。RN 模型配置界面、图片读取尚未接入。
- 应用配置按字段严格分工：piko.json 统一管理 agent 模型预设与可选连接选项、通道和工具行为，models.json 管模型目录；重试和自动压缩直接沿用 Durable 默认策略；HTTP/工作区部署参数和凭据仅环境/.env。旧 settings.json、auth.json 与行为环境变量均不读取；OAuth 刷新只写私有 .env。启动时校验，修改后重启。[应用配置](docs/features/application-config.md)。
- RN/TG 运行中输入使用 steer all，输入分别去重，助手消息独立展示；停止撤回待应用输入。主动压缩已区分实际应用、未生成摘要、过时、取消和失败。
- 正式 Web 构建和 start 单进程入口已接入，网页/API/SSE/TG 共用端口，提供 Linux systemd 模板；Web 默认同源 API。[部署说明](docs/features/linux-deployment.md)。
- 后台子 Agent 已接入：共用配置和资源、禁止嵌套；一次委派一个持久化子会话，结果私下 follow-up 回传，不增加展示。普通停止保留子工作，重启只恢复已完成结果的回传。[功能说明](docs/features/background-subagents.md)。
- 定时事项首版已接入：一个 Prompt、可选 once/Cron、一个固定目录；任务在 Chat 里创建，Tasks 只展示任务、上次结果与时间线，干预只保留归档。每次新建子会话，加载本事项记忆，结果同普通子 Agent 回传主 Agent。原生 doc 保存定义/游标和回执，执行状态从原生任务投影。[功能说明](docs/features/scheduled-work-items.md)。
- 主聊天列表铺满可用屏幕，头部、输入框和导航悬浮；上下采用对称的浅色渐隐背景；头像在胶囊外，名字与活动状态上下排列在自适应胶囊内，正常空闲只显示名字。导航只保留 Chat / Posts / Artifacts / Tasks；Chat / Posts / Tasks 可用（Posts 为空状态占位）；左上菜单、右上设置、附件和 Posts / Artifacts 导航仍禁用，不建设 Ideas。

## 近期开发顺序

| 增量 | 用户可见结果 | 范围 | 状态 |
| --- | --- | --- | --- |
| 1. 工作区与主会话模型 | 重开应用和重启服务仍回到同一主会话 | 工作区初始化、Pi 资源范围、固定 Harness/root、原生 JSONL/submission、Pi 上下文恢复、中断处理 | 首个增量已实现；真实长对话/设备行为继续验证；[功能说明](docs/features/workspace-and-main-chat.md) |
| 2. 工具与技能使用 | 助手能保存工作成果与可复用流程 | Pi 内建文件/命令工具、技能正文读取与创建、脚本执行；管理界面、来源追踪与访问边界后续设计 | 基础工具已启用；产品化管理待设计 |
| 3. RN 与 Telegram 双通道 | 可通过 TG 私聊使用同一个助手，RN 可看到共享历史与执行状态 | 文本回复、停止、详细状态/只读查询、模型/思考按钮、压缩、输入去重、回复呈现与 RN 前台同步；复杂能力单独讨论 | 首期代码与自动化已接入；[通道说明](docs/features/telegram-channel.md)；真实 Bot 与设备行为待验证 |
| 3a. 运行中输入 | 助手工作时仍可补充、纠正要求，RN/TG 遵循相同规则 | 输入使用 durable `whenBusy: "steer"`，运行时使用 `steeringMode: "all"`；独立提交、独立助手消息、停止与通道投递 | 已实现并通过原生 faux 模型与模拟通道测试；真实 Bot 和设备体验待验证 |
| 4. Posts、Artifacts 与 Tasks | 查看主动帖子、工作产物和任务 | Tasks 首版：Chat 创建、人工时间标签、固定目录、记忆与主 Agent 回传；页面只读展示与最少干预 | Tasks 已实现，原生自动化与临时 Web/faux 联调通过；真机和真实模型待验证；[功能说明](docs/features/scheduled-work-items.md) |

当前以应用配置确定工作区，一个 PIKO_HOME 使用一个 Harness/root；身份、提交、执行和状态复用 Durable 原生存储。Message 是原生记录的展示投影，持续会话事件只用于实时传输，重连通过最新快照恢复，不维护重放缓存。主会话是默认入口，side chat 的交互与上下文关系待设计，不做会话列表或切换交互。记忆目录与指导文件可以先建立，自动提取和检索不因此算完成。

关键验收是：主会话唯一、模板不覆盖用户内容、原生历史和上下文能恢复、压缩不影响 UI 历史、重复提交不重复执行、重启明确中断、停止和重连仍可用。接口及恢复细项见功能方案；不保留旧数据库兼容。

## 已确定的修正与运行时复用

以下按标题标注当前实现与后续方向。durable API 以仓库锁定的 1.1.0 类型和源码为准，上游 main 的例子可能已改变接口；例如工具返回值当前使用 `content`，不能直接照搬 main 示例中的 `output`。

### 运行中输入：steer all（已实现）

- RN 与 Telegram 的普通文本都允许在回复期间提交，统一使用 `Conversation.submit({ type: "input", whenBusy: "steer", ... })`，Harness 设置 `steeringMode: "all"`。空闲输入正常启动执行，忙碌输入进入原生 inbox，在下一个接纳边界按顺序全部加入当前工作。持续到来的后续消息进入下一次边界。
- steer 在当前工具轮结束或最终回复边界接纳输入，不能强行打断已经开始的模型请求或工具。普通输入不使用忙碌拒绝或等待当前工作回答后另起执行的 follow-up 语义。模型/思考选择等管理操作的空闲限制另外保留。
- 每条输入保留独立原生 requestId，Durable submission 负责去重和状态，entry 引用绑定用户消息；不再维护 Run、哈希、piko.input 或执行分组。网络重投同身份，用户主动重试用新身份。
- 继续用 `watchEvents` 观察执行，原生 entries 展示完整历史；原生 inbox/submission 表达接纳与应用状态，Piko 不建立第二套正文队列。实时快照、SSE、RN 乐观消息、TG 输入身份及回复观察需要覆盖多个输入参与同一执行，避免丢输入、重复消息或重复投递。
- 普通停止针对当前 conversation 执行及尚未应用的 steer 输入；旧停止命令重投不能取消后来的执行。执行失败撤回尚未应用输入并向参与输入报告失败。撤回输入未落入原生用户 entries，不进入最终历史。
- 输入与输出各自展示；RN 保留已完成回复，按消息 ID 更新当前部分；TG 对每条助手消息维护投递对象，补充输入不会重复发送旧内容。TG 加入 RN 正在执行的工作时观察当前未完成消息和后续消息，纯 RN 工作默认不推送 TG。RN 有草稿时发送补充，回复中且草稿为空时停止；原生状态通过会话 snapshot 同步，重连先接收最新快照，提交可按 requestId 查询；输入 POST 与持续 SSE 分开，RN 不再空闲轮询。
- 自动化覆盖 RN/TG 并发接纳、连续多条 steer 在下一工具边界一起应用、独立输入去重、消息独立更新与完整历史、停止撤回、失败收尾和原输入身份重连。重启仍不自动重放不确定执行，真实 Bot 与设备体验待验证。

### 原生存储与会话传输（已实现）

移除 Workspace/Thread/Run/TelegramReceipt 数据库模型，固定 state/durable，由原生 submission 管理 requestId 去重、inbox/live/task 管理接纳和执行。停止命令与重启提示使用原生 doc；不维护输入哈希、失败来源链或 piko.input 标记。输入提交和持续会话观察分开，每次连接先发送最近 50 条可见消息的 snapshot，再接收实时更新；客户端向上滚动按 entry ID 游标加载更早历史，保留已经加载的连续记录。

旧 SQLite 与原生目录不迁移；配置、凭据和工作区保留，新布局初始化新主会话。持久化、停止重投、重启撤回、SSE 重连、steer 和 TG 流式编辑均有原生自动化覆盖。真实 Bot/设备验证仍需继续。

### 主动压缩的结果反馈（已完善）

运行时调用原生 compact、等待摘要任务，再确认结果 submission 实际应用。摘要任务完成但未生成摘要、任务取消、摘要过时无法应用与失败分别处理，只有实际应用才报告成功。

运行时和 HTTP 返回 compacted/skipped/cancelled，skipped 附 no_summary/stale 原因，失败通过错误反馈；TG 采用对应英文提示。已通过原生摘要实际应用、空上下文跳过、reset 使摘要过时、停止摘要生成和生成失败测试，完整原生历史保持可见。后台自动压缩继续由 durable 处理，是否增加可见提醒仍待设计，不因修正主动命令结果就新增通知。

### 后台委派（已实现）与 Side chat（待设计）

[后台子 Agent](docs/features/background-subagents.md) 已接入。主助手继续交流，子 Agent 共用配置、工具和工作区资源，仅禁止嵌套；一次委派新建一个持久化子会话，不继承主聊天历史；额外背景写入任务，不增加展示或完成通知。结果用可信内部 follow-up 交回主 Agent，由它决定回复或保持安静。TG 来源只投递主 Agent 的实际回复，RN 来源不额外推 TG。

同一 Harness 管理 root 与 owned 子 conversation。原生 background Anchor/Reporter 独立于委派工具调用；模型选择同步，报告按原生回答 ID 去重，内部来源与取消元数据用原生 doc，不复制执行状态或正文。普通停止保留后台工作；明确子任务停止撤回尚未处理的报告。重启中断不确定执行，仅恢复已经完成结果的纯回传阶段。自动化已覆盖，真实模型/Bot 仍需验证。

用户 side chat 的专题入口、背景共享与结论回传另行设计，不开放会话切换。事项调度已接入；普通委派并发/成本限额和可靠 outbox 待设计；持久化 checkpoint 不保证外部副作用恰好一次。

### 结构化状态与配置生效（待按功能接入）

- 计划、待办和工作检查点优先用原生 `defineDoc` 管理，通过工具提交修改、section 注入模型上下文；按状态用途选择 history/fork 策略。执行详情和结论仍落在原生 conversation，不引入额外正文存储。
- 规划模式、只读研究等通过 conversation 的实际工具选择实现；权限和文件范围由执行环境约束，cwd 或提示词不能充当沙箱。工具包装或同名覆盖按真实需求接入，优先复用内建工具。
- 模型与应用配置修改后重启生效，用户指导和技能索引每次请求刷新。Piko 内建 Durable Extension 随服务端代码部署；不提供用户插件目录或运行时热替换入口。

参考：[输入与 inbox](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#busy-conversations)、[前台委派](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/22-subagent-foreground.ts)、[后台委派](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/23-subagent-background.ts)、[压缩](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/25-compaction.ts)、[规划模式](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/27-plan-mode.ts)、[重载与重启](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/31-reload-and-restart.ts)。示例用于核对原生能力，实施时仍对照锁定版本。

## 后续方向

| 能力 | 核心结果与依赖 |
| --- | --- |
| Background Tasks | 后台委派与事项调度已接入，复用原生任务、文档、子 conversation 和回传；普通委派并发/成本限额与可靠 outbox 后续设计 |
| Tasks | 首版 Chat 内创建、定时、结果时间线与最少的干预操作已接入；执行预算、语义阻塞与更丰富产物按需要扩展 |
| Memory | 在工作区基线上实现提取、检索、来源追踪、可纠正与可删除；按实际需求可提前独立推进 |
| Notifications | 有可追踪的重要执行结果后，再加入 Inbox、原生推送和重要性筛选 |
| Posts | 助手主动发布有来源和反馈的内容，复用浏览器/搜索能力；页面已占位，发布、来源与反馈待设计 |
| Artifacts | 查看文件和结构化成果，关联主聊天及任务；产品界面待设计 |
| Browser Computer | 持续的浏览器与执行环境，用户可查看和接管；早期只读公开网页与人工接管 |
| Secrets + Permissions | 凭据存储、权限范围、撤权和审计；先于私人账号连接器与自动外部操作 |
| Connectors | 日历、邮件等授权、撤权、刷新和失败恢复 |
| Agent-native UI | 基于真实结构化产物提供 Dashboard、Tracker 等交互 |
| Side chat | 一个工作区 Harness 下多个 conversation；用户专题与 owned 委派区分，专题入口、上下文范围和结论回传待设计 |

一级产品模块仅 Chat、Posts、Artifacts、Tasks，不建设 Ideas；表中其他能力是工具或模块内部能力，不代表新增独立一级页面。这些是方向及依赖，不是每项都立即开工的承诺。协议适配（包括 AG-UI）随真实工具、事件和 UI 需求推进，Pi 始终是唯一 Agent 运行时。页面在能力可用且验收后启用。

## 功能方案与完成标准

复杂功能临近开发时放进 `docs/features/`，写清状态、场景/目标、范围、交互与状态、数据/API、失败恢复、实施顺序、验收和待定问题。简单改动不必单独建文档。

完成时更新方案状态及本路线图，并将长期约定同步回架构/产品文档。每个增量必须覆盖用户可见的空状态、进行中、失败和完成；关键并发、去重与恢复有自动化验证。原生键盘、网络和后台切换补设备验证，不把导出成功当成真机验证。
