# 后台工作与子 Agent

用户侧称“后台工作”，不要求用户理解子 Agent；内部类型、模块和工具仍使用 subagent。它与保存后可反复运行的“任务（AssistantTask）”不同，后者的每次运行称“执行”。

状态：后台委派已实现，子 Agent 不嵌套或单独展示。结果私下交回主 Agent，由它决定继续工作、回复用户或保持安静。隔离模拟环境覆盖主要行为；真实模型与 Telegram Bot 行为仍需验证。

## 共享资源与会话

主、子 Agent 共用同一个 Harness、Durable 原生 SQLite 存储、基本工具、内建扩展和技能。后台子 Agent 不加载 `core.md`、工作区 `AGENTS.md` 或全局 `MEMORY.md`；它有自己的子角色说明，只接收显式委派内容。之后新建的后台工作使用 `agent.profiles.background`；未配置时动态跟随主模型，显式配置后才独立。主模型变化不改写已启动后台工作。普通委派共用工作区，没有独立配置或记忆目录；子工具移除全部 `subagent_*` 和 `task_*`；委派工具只允许主会话和有效未归档旁聊，任务管理只允许 root。

[任务与执行记录](tasks.md) 复用相同 Anchor/Reporter 和回传机制，cwd 同为主工作区，另以完整路径指定任务专属目录，用于本任务记忆、中间材料及必要留底；操作位置与最终交付方式由具体任务决定。本文其余共享文件与不增加展示的约定针对普通聊天委派；Tasks 页面单独展示任务执行记录，不把内部子消息投影到主聊天。

每次 spawn 创建新的原生 conversation；send 可继续已有子会话并复用其历史：运行中直接以 steer 插入当前工作，空闲时作为新输入启动下一轮。需要不带旧上下文的新会话时再 spawn。后台工作不提供会话列表或切换页面；用户旁聊是独立功能，见[旁聊](side-chats.md)。

子会话在 spawn 时直接新建，不 fork 或继承主聊天历史；加载技能索引和工具，并接收本次委派任务，不加载全局指导与记忆。保存任务的执行仍会加载该任务自己的 `MEMORY.md`。后续 send 复用该子会话的历史，主 Agent 仍应把新增背景写入 `subagent_send.message`。任务由 Reporter 单独提交，子执行不实时回灌 root；工具、压缩和回答保存在子 conversation 中。UI 只投影 root 的完整历史。

主模型和思考强度统一作用于主聊天与旁聊；后台子会话在 spawn 时使用显式配置的 background 模型，未配置时动态跟随全局 main，后台思考强度可单独覆盖。已启动后台工作保持自己的原生模型选择，不被角色设置覆盖；后台供应商缺凭据时 spawn 报错并使该次任务失败，不阻止后端启动，也不静默回退。模型目录与凭据由部署管理并按部署流程重启；角色模型选择无需重启并作用于后续安全边界；指导和技能索引按每次模型请求依据显式资源策略刷新。

共享文件并发修改由主 Agent 分工协调，不强制独立 cwd 或 artifacts 目录。本机权限与当前基本工具一致，cwd 和提示词不是沙箱。

## 委派与回传

主 Agent 使用五个独立工具，各自的必填参数直接体现在 schema 中；后台委派不提供 HTTP 管理 API 或 TG 命令：

| 工具 | 必填参数与行为 |
| --- | --- |
| `subagent_list` | 无参数；返回普通委派的 id、标题、简短初始任务和当前状态，不展开历史或步骤，排除保存任务的执行 |
| `subagent_spawn` | 必填 `title`（简短任务描述）和 `task`（完整指令）；创建新子会话，立即返回原生会话 ID，不等待结果 |
| `subagent_send` | `id`、`message`；继续已有子任务：运行中以 steer 插入当前工作，空闲时启动下一轮 |
| `subagent_status` | `id`；返回该任务执行状态：`working` / `interrupted` / `stopped` / `failed`（附原因）/ `finished`，并附最近 5 步（工具调用摘要 + 助手输出，单步截断） |
| `subagent_stop` | `id`；取消指定的子任务，不停止主 Agent |

结果自动私下回传，不提供额外 wait/yield 工具，也不鼓励循环轮询。五个入口使用 Durable 原生任务、提交、权限和取消路径，不复制执行状态。`subagents/tools.ts` 负责 schema、服务/查询调用与输出；`subagents/delegations.ts` 负责普通委派配置、owner/用途校验及列表投影；`subagents/runtime.ts` 承载共享 Anchor/Reporter、创建/继续/停止和回传；`subagents/queries.ts` 只负责公共原生事实；`subagents/recovery.ts` 在 resume 前实施恢复。Agent 的空白/fork 构建与资源选择独立在 `agents/`；保存任务的 Prompt、目录和记忆由 `tasks/agent.ts` 组装，不进入公共 runner。详见[Agent 构建与后台执行](agent-composition.md)。任务服务依赖共用执行和事实读取，不依赖普通委派工具。列表可用于重新找到已有工作；任务摘要从原生 Reporter 输入读取，状态从 task/submission/live 投影。

工具成功返回统一使用 JSON 文本：

- list：`{"subagents":[{"id":"23","title":"检查配置","task":"检查配置并报告结果","status":"working"}]}`，空列表为 `{"subagents":[]}`。旧委派没有标题时回退到初始任务摘要。
- spawn/send：`{"id":"23","status":"accepted"}`，只表示已接纳，不表示工作完成。
- status：`{"id":"23","title":"检查配置","status":"finished","recentSteps":["已检查配置"]}`；失败可附 `detail`，最近步骤最多五条。
- stop：`{"id":"23","status":"stopped"}`。
- 工具主动拒绝的未知 id、越权或空指令：`{"status":"error","error":"…"}` 并标记 `isError`；schema 校验与原生执行异常仍由 SDK 处理。

普通用户输入仍进入主会话，维持 steer all，不广播给所有子 Agent。报告以内部 input、whenBusy:followUp 回传：主 Agent 空闲时唤起处理，忙碌时等待当前回答结束。报告不是新的用户指令，不强制生成完成通知。

RN/Web 在主 Agent 调用委派工具期间显示标题，TG 的工具活动摘要也显示标题；这只是调用时的短暂状态。TG 的 `/subagent` 列表和详情显示已保存的标题，旧委派回退到初始任务摘要。RN/Web 和 TG 不显示子 Agent 消息、工具过程、状态卡片或内部报告气泡。可信来源由运行时原生文档记录，历史和 queued 输入都按该来源过滤；外部 requestId 禁用 piko: 命名空间，正文写成“内部报告”仍是普通用户消息。

子会话的原文、工具过程和状态不直接投递。回传到 root 后，主 Agent 是否回复仍由它决定；一旦主会话产生助手消息，该消息投递到 Telegram，不再按委派输入的来源筛选。主 Agent 保持安静时没有助手回复通知。保存任务的执行结果同样经主会话整理，见[任务与执行记录](tasks.md#回传与恢复)。Rich Markdown 和按助手消息独立投递保持原样。平台状态在内存，不保证重启补发或恰好一次送达，原生历史仍可查看。

## 原生实现与持久化

```text
一个 Harness / state/durable
└─ root conversation
   ├─ 主 Agent 当前工作
   ├─ background Anchor task → 拥有子 conversation
   └─ background Reporter task → 提交任务 → 等待回答 → 回传 root
```

Anchor 是立即完成的持久化所有权节点，不是常驻线程；子会话不挂在短暂 spawn 工具调用上。Reporter 独立于当前主执行，原生 task、submission、InboxDoc 和 LiveDoc 管理调度、接纳、等待与终态，不增加数据库、Run 或第二套正文存储。

Reporter 用稳定 requestId 提交子输入和主报告。多个 steer 可对应同一个原生 answer entry，按 answer 身份只回传一次；回传决定与下一阶段 checkpoint 在同一 native commit 保存。checkpoint 保存 answer entry 引用或原生失败原因，报告正文从原生回答读取。

原生文档只补充产品所需元数据：piko.input-origin 保存通道来源、内部报告标记及关联子会话；piko.subagent-control 保存显式取消的 epoch 和已报告 answer ID；piko.agent-resources 保存资源选择，piko.background-job 保存用途、委派标题、继续规则和回报来源标题/投递提示。执行状态仍以 Durable 为准，不保存状态副本。报告先经过父会话的 ConversationControl 接纳线，再进入后台取消接纳线，并在两者内部复核 epoch；同一顺序用于归档，避免反向持锁。归档预留覆盖停止前台、撤回报告、停止子工作和写入元数据全过程，归档后的报告不能再次唤起会话。原生提交去重与 checkpoint 保持不变。

## 停止、失败与重启

普通停止取消主会话当前非 background 工作及未应用输入，子任务继续；重复停止请求仍绑定原目标，不影响后来执行。主模型失败收尾也不取消独立子任务。

指定子任务停止会使取消 epoch 前进、撤回 root 中该任务尚未处理的报告，并调用子 conversation.abort 撤回待应用输入、取消当前执行。迟到报告不再唤起 root；已经被主 Agent 处理的结果无法撤回。stop 必须指定具体子任务，不提供批量停止。子任务失败私下回传失败原因，其他任务继续，主 Agent 决定是否告知用户。

启用调度前检查原生任务：撤回遗留未应用输入，取消主/子不确定执行；只保留未被请求取消、已经完成回答的 Reporter report 阶段，随后 resume 递送结果。保存历史及子会话，显示重启中断提示，不自动重放模型请求、bash 或其他不确定副作用。关闭 Harness 保留原生阶段，重开统一执行此策略。

原生去重保证重复递送同一身份不重复接纳；它不保证外部工具副作用或 TG 网络发送恰好一次。

## 保留与清理

有业务归属的后台工作随所属对象删除：旁聊删除清理其所有权子树，保存任务删除清理历次执行。主会话下的普通委派属于临时执行，每 24 小时检查一次，整个执行树最后活动满 7 天且全部终结后回收。新输入、继续执行或显式停止会延后到期；运行中、输入/报告未消费、树外 fork 或活动依赖不清理。过期 ID 不再可查看或继续，父会话已接收的报告和答复、工作区文件及产物不受影响。共用删除、安全边界与启动恢复见[存储维护](../operations/storage.md#临时执行的保留期)。

## 验证状态与限制

五个工具在隔离工作区中覆盖了列表、状态查询、接纳、继续、停止、权限隔离和持久化恢复。标题必填、空白校验、元数据写入、旧任务回退以及活动展示已用隔离模拟检查；尚未通过真实模型验证生成标题。验证不调用真实模型供应商或 Telegram Bot。

任务执行与普通后台委派共用运行时，见[任务与执行记录](tasks.md)。普通后台委派没有独立管理界面或自动续跑能力；并发/成本限额与可靠平台 outbox 尚未实现。旁聊委派受发起旁聊的 owner 范围约束，报告只回原旁聊。
