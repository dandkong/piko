# 工作区与主会话模型

状态：已实现原生存储简化，使用 pi-durable / pi-ai 1.1.0。Piko 不再维护 SQLite 和 Run。架构见 [ARCHITECTURE](../ARCHITECTURE.md)，模型与运行时见 [Durable 配置](durable-runtime.md)。

## 范围与初始化

一个 PIKO_HOME、一个长期工作区、一个 Harness/root 主会话；后台委派使用同一 Harness 的持久化子会话，不增加展示，见 [后台子 Agent](background-subagents.md)。[定时事项](scheduled-work-items.md) 已在同一 Harness 接入，Tasks 管理 Prompt、时间规则、事项记忆和历次结果。每日/长期记忆 Review 已接入；Side chat、工具进度和全局产物管理尚未实现。

默认 PIKO_HOME 为 ~/.piko，仅部署环境 PIKO_WORKSPACE 可指定绝对工作区；加载见 [应用配置](application-config.md)。初始化只补缺失配置和模板，保留用户内容。state 在工作区外，通过后端锁限制单写进程。已有主会话 cwd 与配置不同则拒绝启动，恢复原路径或使用新 PIKO_HOME。

| 存储 | 内容 |
| --- | --- |
| config/piko.json、.env | 应用配置与可选覆盖 |
| config/piko.json、models.json | 统一的非敏感 Agent/通道/工具行为，以及独立模型目录；不再生成 settings.json |
| config/.env 与进程环境 | 部署参数与敏感凭据，不覆盖 JSON 行为 |
| state/durable/ | main.jsonl 与 doc-*.jsonl，唯一持久会话与执行状态来源 |
| state/tmp/ | 工具溢出与可清理临时文件 |
| 当前进程内存 | 流式消息、输出合并、Session 中待挂接的后台回传、TG 投递身份 |
| workspace/ | AGENTS.md、MEMORY.md、memory/ 每日记忆、技能与工作成果 |

没有 Piko 身份表、执行表、输入哈希、正文副本或永久 SSE 日志。停止去重和中断提示使用原生文档，不重复保存任务状态。旧 SQLite 和 durable-sessions 不迁移，也不作为当前主会话来源。

## 展示与上下文

展示从原生原始 entries 正序投影用户/助手文字，保留 reset、上下文编辑和压缩前历史。气泡 ID 为 pi-<entry ID>，时间来自原生消息。工具、思考、隐藏 entry 和压缩摘要不显示；display=true 的 piko.result 可形成被动回复。

Web/RN 的首次快照与后续 SSE 快照只传最近 50 条可见已保存消息，另附当前流式消息与未应用输入。`GET /api/chat/history?before=<entry ID>` 向前读取至多 50 条，`nextBefore` 表示还可向前翻页；游标基于不可变 entry ID，新增消息不会移动旧页边界。每页与状态在原生 commit 线上读取；提交绑定从原生 submission 初始化并随 commit 更新，不新建正文或永久索引。

客户端向上滚到顶部附近自动加载更早消息，可手动点击加载或失败重试；加载时保留阅读位置。最近快照覆盖所含范围及临时输入，不清掉已经翻出的更早记录。失联期间若增长超过最近窗口、与客户端记录无交集，则重置到最新页，避免掩盖中间缺口；旧请求的分页响应不混入新窗口。客户端仅加载访问过的页，但目前不会自动淘汰已加载页；服务端运行时仍保留完整原生历史用于事件恢复，启动与运行时内存不因此变为常量。

每条用户消息从原生 submission.entry 获取 requestId，不额外写 piko.input。助手消息独立展示，不累计整轮回答、不强行配对。当前流式消息采用临时 ID，保存后原位替换；原生 inbox 里的未应用输入临时显示，撤回后消失。模型上下文和压缩由 Durable 处理，UI 不读取压缩后的 context 代替历史。

## 执行、停止与传输

POST /api/chat 接收 {requestId,message}，返回原生提交回执。RN 新请求生成 UUID，网络重试保持该 ID；TG 使用 telegram:<botId>:<chatId>:<messageId>。同 ID 返回原提交；新意图使用新 ID，不再做哈希冲突或 retryOfRunId 关联校验。用户主动重试生成新 ID，连接恢复只观察、不自动重发。

输入、停止与维护预留由 DurableChatSession 的单一接纳线协调；ConversationStore 只负责文本校验、输出合并与观察，不重复维护锁或后台回传缓存。普通输入使用 whenBusy=steer 与 steeringMode=all，运行期间仍可接纳，在原生边界全部应用；不强行打断模型或工具。模型/思考选择及手动压缩占用空闲边界，期间普通输入立即拒绝；停止可取消压缩。

GET /api/chat/events 是持续会话 SSE，与每条输入提交分开。每次连接先发送最近一页的 authoritative snapshot，再继续实时更新；不使用事件游标和重放缓存，不补齐断线期间的中间流式事件。首次快照与实时订阅仍衔接在同一发布线上，防止漏掉期间的变化。消息更新最多 50ms 合并，15 秒心跳，客户端 30 秒无数据重连并有限退避。断线、页面卸载和退后台均只退订，服务端继续工作。

POST /api/chat/stop 以独立 requestId 停止 conversation 和待应用输入。原生 piko.stop 文档记录当时的 task ID，重复请求只取消原目标，不影响之后的新工作。执行失败也结算和撤回剩余输入；未落入原生用户 entries 的输入不进入最终历史。提交状态使用原生 queued/placed/done/unanswered，不另存 Piko 终态。

RN 在前台持续观察两通道变化，原生快照加未确认的本地输入构成列表；过期 HTTP 刷新不会覆盖较新的观察结果。TG 按助手消息维护投递，网络发送不阻塞接纳或执行。接口见 [架构说明](../ARCHITECTURE.md)，通道边界见 [Telegram 通道](telegram-channel.md)。

## 资源与工具

核心指导随应用发布，工作区保存由用户定制的指导与记忆文件。注入时标注来源路径和 `role`，职责如下：

| 文件 | role | 职责 |
| --- | --- | --- |
| 应用 `core.md` | core | 应用运行规则、工具使用与结果真实性，不固定助手名字或语气 |
| 工作区 `AGENTS.md` | work_guidance | 如何表达和做事：助手名字、语气、回复偏好、工作方法、文件组织和交付约定；默认名字 Piko 在此定义 |
| 工作区 `MEMORY.md` | memory | 需要记住的事实：用户资料、环境事实、项目决定与长期结论；不推测未提供的信息，不作为聊天记录或操作授权 |
| 工作区 `memory/YYYY-MM-DD.md` | memory（按需读取） | 每日记忆：当天有延续价值的讨论、已确认的决定、做过的事、用户近况与未完线索；不自动注入 |

希望助手怎么做放在 AGENTS.md，需要长期记住的事实放在 MEMORY.md；每日讨论、决定、进展和未完线索放在 `memory/YYYY-MM-DD.md`。各文件内部用 Markdown 小节组织，无需按身份、用户资料等再次拆文件。

`role` 是资源用途标注，不是独立的模型消息权限层级，也不构成安全隔离。实际能力与文件访问边界必须由运行时实现。

core.md 与工作区 AGENTS.md 上限各 8,000 字节，MEMORY.md 上限 4,000 字节。每次模型请求重新加载指导和技能索引，技能正文通过 read 按需读取；每日记忆不自动注入，相关时由助手通过工作区 read/search 查阅。初始化只补缺失的 AGENTS.md、MEMORY.md，模板升级不覆盖已有用户文件。其他旧指导文件不再初始化或加载，也不会自动删除或搬移其内容。

### 每日与长期记忆 Review

主会话结束并闲置 30 分钟后，运行一个独立 Durable 后台 Memory Review task。它只选取上次游标之后新增的主会话原始用户/助手文本，不处理内部子 Agent 回报、工具日志，也不回填启用前的历史。没有可读新增文本时只推进游标，不调用模型。Review 只由后台闲置调度触发，不向主 Agent 提供手动触发工具；不会完成后向主聊天发回报。

一个 Review task 启动专用子会话，只配置 `read`、`write`、`edit` 三个工具，由 reviewer 读取当前文件并直接编辑；不提供 bash。一次 Review 同时维护两类记忆；为了使用文件工具，模型可能经历多个工具调用轮次。

- `memory/YYYY-MM-DD.md` 追加有延续价值的讨论/想法、已确认决定与变化、做过的事项及结果、用户主动分享的近况和未完线索；允许短期细节，不写逐条来源 ID。
- `MEMORY.md` 只保留仍有效、跨会话值得携带的稳定背景、偏好、约定和长期结论；不将每日记忆摘要直接照搬成事实，并可按明确纠正更新过时内容。

游标、活动 task 和重试状态存于 Durable 文档，不写进记忆正文。Reviewer 被提示只改 `MEMORY.md` 和本批对应的日期文件；但这只是行为约定，不是权限沙箱：三个工具使用后端本机权限，`write`/`edit` 仍可指向任意路径。文件写入与 Durable 游标不在同一事务；task 中断时不自动续跑，游标不推进，后续新 Review 会先读取当前文件再处理原范围。程序不做文件哈希冲突检测、回滚或写入结果独立校验；若写文件后中断，避免重复依赖 reviewer 判断。这比候选 JSON + 程序提交更简单，但并发改写和模型未正确落盘时的保护更弱。

技能来源为工作区 `.agents/skills` 与应用内建技能；同名时工作区版本优先，同名覆盖有诊断。`PIKO_HOME/skills` 不创建也不读取。不继承个人 Pi CLI、祖先指导或全局扩展。模型配置独立于 Pi CLI；Durable Extension 只由 Piko 内建代码注册，用户 skill 不增加运行时工具。

read/write/edit/bash 保持启用，相对路径默认工作区，本机 Shell 执行命令。cwd 不是沙箱；目前没有操作审批 UI。durable 1.1.0 的 read 尚不能读取图片，附件仍是禁用占位。记忆 Review 已实现；专门的记忆浏览、检索和版本管理 UI 尚未实现。

## 中断与损坏恢复

1. 启动取得锁、打开固定 state/durable，校验日志、root 与工作区关联。
2. 完整损坏记录拒绝继续；剩余 doc 日志但 main.jsonl 缺失时明确报错。Durable 自行恢复残尾与未确认 sidecar 事务。
3. 启用调度前撤回遗留输入并取消不确定执行；仅保留已完成子任务的 Reporter report 阶段，随后 resume 回传结果，不自动重跑模型和工具。
4. 有遗留生成或输入时写原生 piko.recovery 中断提示和隐藏上下文说明，不复制输入、不调用模型；下一次接纳清除提示。
5. 已保存历史继续展示；尚未保存的文字不保证恢复。恢复不回滚工具的外部副作用。

## 开发数据与备份

当前布局不兼容旧版元数据，不迁移旧聊天；旧 durable-sessions 保留但不读取，新主会话在 state/durable 初始化。旧 piko.sqlite 及其 WAL/SHM 可在停止后端后删除，配置、模型凭据、工作区文件和技能不随清理删除。需要完全重置新会话时，先备份并停止后端，再清理整个 state/durable，不能只删除 main.jsonl。

备份停止 API 后复制整个 PIKO_HOME 和单独指定的工作区，main.jsonl 与 doc-*.jsonl 成套保存；恢复保留原工作区绝对路径。

## 后续与验证

原生文档、任务、conversation 与 write submission 可承接未来产品状态和被动结果；事项调度、后台委派及已完成结果的回传恢复已接入；可靠投递 outbox、权限及 side chat 交互尚未实现。

自动化覆盖初始化/路径、原生去重与重启、完整历史、分页与游标验证、隐藏记录、分页与快照合并/缺口恢复、压缩、残尾/损坏/缺失、中断撤回、内建工具/模型选择、HTTP/SSE 重连、steer all、旧停止命令、维护取消和 TG 流式投递。真实设备网络、前后台、键盘和长对话仍需使用验证。
