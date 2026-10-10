# Piko 开发路线图

当前是具备持久主会话的文本聊天原型。已完成 UI、基本流式交互，以及工作区和聊天持久化首个增量。产品方向见 [PRODUCT](docs/PRODUCT.md)，技术约定见 [ARCHITECTURE](docs/ARCHITECTURE.md)。

## 当前基线

- Expo / React Native 覆盖 Web、iOS、Android；已打磨聊天布局、输入、滚动与等待动效，并增加根目录 Android 原生启动命令。
- 助手消息支持 Markdown 与流式未闭合语法显示，代码块和表格支持横向滚动；用户消息保持原文。
- Bun 托管 pi-durable 1.1.0 + pi-ai 1.1.0，使用 HTTP + SSE 提供文本流、停止、错误重试、提交去重、快照、断线/刷新/前台恢复。
- 服务端唯一主会话，Durable 原生 JSONL 是唯一会话内容来源；UI 投影完整 conversation entries，SQLite 只保存必要元数据；重启恢复已保存消息并明确标记中断 Run，流式片段不另行持久化。
- 工作区初始化、有限指导/技能发现与 Pi 的 read、write、edit、bash 四个内建工具已启用；可读取/创建技能和执行脚本，全局扩展不自动加载。
- 独立 JSON 模型/凭据/预设配置、思考强度、durable 插件及选择/压缩/取消 API 已接入；TG 增加模型/思考按钮菜单、压缩与详细状态，共享主会话选择和空闲限制。[配置说明](docs/features/durable-runtime.md)。RN 模型配置界面、图片读取尚未接入。
- HTTP、工作区与 Telegram 已迁移到统一应用配置，支持 `piko.json`、共享 `.env` 和进程环境覆盖；启动时校验，修改后重启。[应用配置](docs/features/application-config.md)。
- RN/TG 运行中输入使用 steer all，分别去重并共享执行/回复；停止撤回待应用输入。主动压缩已区分实际应用、未生成摘要、过时、取消和失败。
- 菜单、通知、附件、Activity / Ideas / Goals / Apps 是禁用占位。

## 近期开发顺序

| 增量 | 用户可见结果 | 范围 | 状态 |
| --- | --- | --- | --- |
| 1. 工作区与主会话模型 | 重开应用和重启服务仍回到同一主会话 | 工作区初始化、Pi 资源范围、核心实体、JSONL 与 SQLite 索引、Pi 上下文恢复、中断处理 | 首个增量已实现；真实长对话/设备行为继续验证；[功能说明](docs/features/workspace-and-main-chat.md) |
| 2. 工具与技能使用 | 助手能保存工作成果与可复用流程 | Pi 内建文件/命令工具、技能正文读取与创建、脚本执行；管理界面、来源追踪与访问边界后续设计 | 基础工具已启用；产品化管理待设计 |
| 3. RN 与 Telegram 双通道 | 可通过 TG 私聊使用同一个助手，RN 可看到共享历史与执行状态 | 文本回复、停止、详细状态/只读查询、模型/思考按钮、压缩、输入去重、回复呈现与 RN 前台同步；复杂能力单独讨论 | 首期代码与自动化已接入；[通道说明](docs/features/telegram-channel.md)；真实 Bot 与设备行为待验证 |
| 3a. 运行中输入 | 助手工作时仍可补充、纠正要求，RN/TG 遵循相同规则 | 输入使用 durable `whenBusy: "steer"`，运行时使用 `steeringMode: "all"`；独立输入身份、共享执行投影、停止与通道投递 | 已实现并通过原生 faux 模型与模拟通道测试；真实 Bot 和设备体验待验证 |
| 4. Activity 与 Artifacts | 看见助理做了什么、生成了什么 | 执行轨迹、事件与文件/结构化产物查看 | 待设计 |

当前落地 Workspace、Thread 和精简的 Run 元数据；Message 是 Pi 原生记录的展示投影，流事件只用于实时传输与内存重放。主会话是默认入口，side chat 仅预留类型与关联，不做会话列表或切换交互。记忆目录与指导文件可以先建立，自动提取和检索不因此算完成。

关键验收是：主会话唯一、模板不覆盖用户内容、原生历史和上下文能恢复、压缩不影响 UI 历史、重复提交不重复执行、重启明确中断、停止和重连仍可用。接口及恢复细项见功能方案；不保留旧数据库兼容。

## 已确定的修正与运行时复用

以下按标题标注当前实现与后续方向。durable API 以仓库锁定的 1.1.0 类型和源码为准，上游 main 的例子可能已改变接口；例如工具返回值当前使用 `content`，不能直接照搬 main 示例中的 `output`。

### 运行中输入：steer all（已实现）

- RN 与 Telegram 的普通文本都允许在回复期间提交，统一使用 `Conversation.submit({ type: "input", whenBusy: "steer", ... })`，Harness 设置 `steeringMode: "all"`。空闲输入正常启动执行，忙碌输入进入原生 inbox，在下一个接纳边界按顺序全部加入当前工作。持续到来的后续消息进入下一次边界。
- steer 在当前工具轮结束或最终回复边界接纳输入，不能强行打断已经开始的模型请求或工具。普通输入不使用忙碌拒绝或等待当前工作回答后另起执行的 follow-up 语义。模型/思考选择等管理操作的空闲限制另外保留。
- 每条输入保留独立 Run 身份与哈希去重，多个输入通过 executionId 关联同一次执行、共享回答。`piko.run` 关联执行与多段回复，`piko.input` 仅记录输入身份和执行关系，通过原生 submission 的 entry 引用绑定用户消息。
- 继续用 `watchEvents` 观察执行，原生 entries 展示完整历史；原生 inbox/submission 表达接纳与应用状态，Piko 不建立第二套正文队列。实时快照、SSE、RN 乐观消息、TG 收据及回复观察需要覆盖多个输入参与同一执行，避免丢输入、重复消息或重复投递。
- 普通停止针对共享执行及尚未应用的 steer 输入；旧停止命令重投不能取消后来的执行。执行失败撤回尚未应用输入并向参与输入报告失败。撤回输入未落入原生用户 entries，不进入最终历史。
- TG 对同一次执行只维护一组回复；TG 主动加入 RN 发起的执行时可观察该共享回复，纯 RN 执行默认不推送 TG。RN 有草稿时发送补充，回复中且草稿为空时停止；跨通道用户输入通过 refresh 事件同步，重连支持按原输入 runId 查询。
- 自动化覆盖 RN/TG 并发接纳、连续多条 steer 在下一工具边界一起应用、独立输入去重、共享文本/历史、停止撤回、失败收尾和原输入身份重连。重启仍不自动重放不确定执行，真实 Bot 与设备体验待验证。

### 主动压缩的结果反馈（已完善）

运行时调用原生 compact、等待摘要任务，再确认结果 submission 实际应用。摘要任务完成但未生成摘要、任务取消、摘要过时无法应用与失败分别处理，只有实际应用才报告成功。

运行时和 HTTP 返回 compacted/skipped/cancelled，skipped 附 no_summary/stale 原因，失败通过错误反馈；TG 采用对应英文提示。已通过原生摘要实际应用、空上下文跳过、reset 使摘要过时、停止摘要生成和生成失败测试，完整原生历史保持可见。后台自动压缩继续由 durable 处理，是否增加可见提醒仍待设计，不因修正主动命令结果就新增通知。

### Side chat、委派与后台工作（运行时方向已确定，产品交互待设计）

- 同一工作区采用一个 Harness 管理多个 conversation，共享存储、调度与 registry；模型、思考、工具、指导和 cwd 可按 conversation 配置。当前每个 Thread 独立 Harness/root 的适配器需届时调整，工作目录相关提示 section 使用实际 conversation 的环境。
- 用户专题会话与助手委派会话区分所有权：独立 side chat 不随主会话停止；前台委派采用原生 owned conversation/child task，通过工具 `details.conversationId` 关联查看。新建和 fork 的上下文范围、结论回传方式仍需设计，不自动同步两边全部消息。
- 后台工作复用原生 task、checkpoint、document、write/input submission 和 reporter；外部副作用使用幂等身份，结论回传使用稳定 requestId 去重。write 只写记录，input 会唤起模型，投递方式按产品场景选择。
- 接入后台任务前拆分“停止当前工作”和“停止所有工作”，调整当前统一 `abort({ background: true })` 的范围；前台执行继续采用重启中断策略，哪些后台任务可恢复需明确后再启用。持久化 checkpoint 不保证外部副作用恰好执行一次。

### 结构化状态与配置生效（待按功能接入）

- 计划、待办和工作检查点优先用原生 `defineDoc` 管理，通过工具提交修改、section 注入模型上下文；按状态用途选择 history/fork 策略。执行详情和结论仍落在原生 conversation，不复制消息正文到 SQLite。
- 规划模式、只读研究等通过 conversation 的实际工具选择实现；权限和文件范围由执行环境约束，cwd 或提示词不能充当沙箱。工具包装或同名覆盖按真实需求接入，优先复用内建工具。
- 配置及插件文件当前仍重启生效，用户指导和技能索引每次请求刷新。原生 registry 支持同名替换，但正在运行的阶段保留原快照、后续阶段采用新代码；是否提供重载入口继续待定。

参考：[输入与 inbox](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#busy-conversations)、[前台委派](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/22-subagent-foreground.ts)、[后台委派](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/23-subagent-background.ts)、[压缩](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/25-compaction.ts)、[规划模式](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/27-plan-mode.ts)、[重载与重启](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/31-reload-and-restart.ts)。示例用于核对原生能力，实施时仍对照锁定版本。

## 后续方向

| 能力 | 核心结果与依赖 |
| --- | --- |
| Background Tasks | 复用 durable 原生任务、文档、独立 conversation 和去重投递；先明确停止范围与重启恢复策略，再接入产品调度和 UI |
| Goals | 长期目标关联任务、检查点、时间线和产物 |
| Memory | 在工作区基线上实现提取、检索、来源追踪、可纠正与可删除；按实际需求可提前独立推进 |
| Notifications | 有可追踪的重要执行结果后，再加入 Inbox、原生推送和重要性筛选 |
| Ideas | 基于目标、记忆与实际能力给出可解释、可接受/忽略的建议 |
| Feed | 有来源和反馈的个性化研究，复用浏览器/搜索能力 |
| Browser Computer | 持续的浏览器与执行环境，用户可查看和接管；早期只读公开网页与人工接管 |
| Secrets + Permissions | 凭据存储、权限范围、撤权和审计；先于私人账号连接器与自动外部操作 |
| Connectors | 日历、邮件等授权、撤权、刷新和失败恢复 |
| Agent-native UI | 基于真实结构化产物提供 Dashboard、Tracker 等交互 |
| Side chat | 一个工作区 Harness 下多个 conversation；用户专题与 owned 委派区分，专题入口、上下文范围和结论回传待设计 |

这些是方向及依赖，不是每项都立即开工的承诺。协议适配（包括 AG-UI）随真实工具、事件和 UI 需求推进，Pi 始终是唯一 Agent 运行时。页面在能力可用且验收后启用。

## 功能方案与完成标准

复杂功能临近开发时放进 `docs/features/`，写清状态、场景/目标、范围、交互与状态、数据/API、失败恢复、实施顺序、验收和待定问题。简单改动不必单独建文档。

完成时更新方案状态及本路线图，并将长期约定同步回架构/产品文档。每个增量必须覆盖用户可见的空状态、进行中、失败和完成；关键并发、去重与恢复有自动化验证。原生键盘、网络和后台切换补设备验证，不把导出成功当成真机验证。
