# 后台工作与子 Agent

用户侧称“后台工作”，不要求用户理解子 Agent；内部类型、模块和工具仍使用 subagent。它与保存后可反复运行的“任务（AssistantTask）”不同，后者的每次运行称“执行”。

状态：后台委派已实现，子 Agent 不嵌套或单独展示。结果私下交回主 Agent，由它决定继续工作、回复用户或保持安静。隔离模拟环境覆盖主要行为；真实模型与 Telegram Bot 行为仍需验证。

## 共享资源与会话

主、子 Agent 共用同一个 Harness、Durable 原生 SQLite 存储、基本工具、内建扩展、技能、全局 AGENTS.md 和 MEMORY.md。模型选择不共用：后台子 Agent 使用 `agent.profiles.background`（未配置时在创建时继承当时的主会话选择），主会话的 `/models` 切换不影响它们。普通委派共用工作区，没有独立配置或记忆目录；子工具移除全部 `subagent_*` 和 `task_*`；委派工具只允许主会话和有效未归档旁聊，任务管理只允许 root。子角色说明只补充任务职责，仍加载共享指导。

[任务与执行记录](tasks.md) 复用相同 Anchor/Reporter 和回传机制，但使用固定任务目录作为 cwd，并额外加载本任务记忆、保存独立输出。本文其余共享文件与不增加展示的约定针对普通聊天委派；Tasks 页面单独展示任务执行记录，不把内部子消息投影到主聊天。

每次 spawn 创建新的原生 conversation；send 可继续已有子会话并复用其历史：运行中直接以 steer 插入当前工作，空闲时作为新输入启动下一轮。需要不带旧上下文的新会话时再 spawn。后台工作不提供会话列表或切换页面；用户旁聊是独立功能，见[旁聊](side-chats.md)。

子会话在 spawn 时直接新建，不 fork 或继承主聊天历史；只加载共享指导、记忆、技能和工具，以及本次委派任务。后续 send 复用该子会话的历史，主 Agent 仍应把新增背景写入 `subagent_send.message`。任务由 Reporter 单独提交，子执行不实时回灌 root；工具、压缩和回答保存在子 conversation 中。UI 只投影 root 的完整历史。

主会话模型和思考强度只作用于主会话。后台子会话在 spawn 时读取 `agent.profiles.background`，启动时同步已有子会话的后台选择。后台供应商缺凭据时 spawn 报错并使该次任务失败，不阻止后端启动，也不静默回退到主模型。已经准备的模型请求继续完成，后续请求使用新选择。重启时同步当前后台选择、cwd 与工具选择。配置需重启生效；指导和技能索引按每次模型请求刷新。

共享文件并发修改由主 Agent 分工协调，不强制独立 cwd 或 artifacts 目录。本机权限与当前基本工具一致，cwd 和提示词不是沙箱。

## 委派与回传

主 Agent 使用五个独立工具，各自的必填参数直接体现在 schema 中；后台委派不提供 HTTP 管理 API 或 TG 命令：

| 工具 | 必填参数与行为 |
| --- | --- |
| `subagent_list` | 无参数；返回普通委派的 id、简短初始任务、当前状态，不展开历史或步骤，排除保存任务的执行 |
| `subagent_spawn` | `task`；创建新子会话，立即返回原生会话 ID，不等待结果 |
| `subagent_send` | `id`、`message`；继续已有子任务：运行中以 steer 插入当前工作，空闲时启动下一轮 |
| `subagent_status` | `id`；返回该任务执行状态：`working` / `interrupted` / `stopped` / `failed`（附原因）/ `finished`，并附最近 5 步（工具调用摘要 + 助手输出，单步截断） |
| `subagent_stop` | `id`；取消指定的子任务，不停止主 Agent |

结果自动私下回传，不提供额外 wait/yield 工具，也不鼓励循环轮询。五个入口使用 Durable 原生任务、提交、权限和取消路径，不复制执行状态。`subagents/tools.ts` 负责 schema、服务/查询调用与输出；`subagents/runtime.ts` 承载共享 Anchor/Reporter、创建/继续/停止和回传；`subagents/queries.ts` 负责原生事实读取、owner 校验与普通委派投影；`subagents/recovery.ts` 在 resume 前实施恢复。任务服务依赖共用执行和事实读取，不依赖普通委派工具。列表可用于重新找到已有工作；任务摘要从原生 Reporter 输入读取，状态从 task/submission/live 投影。

工具成功返回统一使用 JSON 文本：

- list：`{"subagents":[{"id":"23","task":"检查配置","status":"working"}]}`，空列表为 `{"subagents":[]}`。
- spawn/send：`{"id":"23","status":"accepted"}`，只表示已接纳，不表示工作完成。
- status：`{"id":"23","status":"finished","recentSteps":["已检查配置"]}`；失败可附 `detail`，最近步骤最多五条。
- stop：`{"id":"23","status":"stopped"}`。
- 工具主动拒绝的未知 id、越权或空指令：`{"status":"error","error":"…"}` 并标记 `isError`；schema 校验与原生执行异常仍由 SDK 处理。

普通用户输入仍进入主会话，维持 steer all，不广播给所有子 Agent。报告以内部 input、whenBusy:followUp 回传：主 Agent 空闲时唤起处理，忙碌时等待当前回答结束。报告不是新的用户指令，不强制生成完成通知。

RN/Web 和 TG 不显示子 Agent 消息、工具过程、状态卡片或内部报告气泡。可信来源由运行时原生文档记录，历史和 queued 输入都按该来源过滤；外部 requestId 禁用 piko: 命名空间，正文写成“内部报告”仍是普通用户消息。

普通委派只回复来源通道：TG 来源经过验证的 Bot/chat 来源，在回传前重新建立 root 回复观察；RN 来源不额外推送 TG。只发送主 Agent 实际生成的文字，主 Agent 保持安静时没有通知。保存任务的执行结果属于例外，会推送到所有通道，见[任务与执行记录](tasks.md#回传与恢复)。Rich Markdown 和按助手消息独立投递保持原样。平台状态在内存，不保证重启补发或恰好一次送达，原生历史仍可查看。

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

两个原生文档只补充产品所需元数据：piko.input-origin 保存通道来源、内部报告标记及关联子会话；piko.subagent-control 保存显式取消的 epoch 和已报告 answer ID。执行状态仍以 Durable 为准，不保存状态副本。报告先经过父会话的 ConversationControl 接纳线，再进入后台取消接纳线，并在两者内部复核 epoch；同一顺序用于归档，避免反向持锁。归档预留覆盖停止前台、撤回报告、停止子工作和写入元数据全过程，归档后的报告不能再次唤起会话。原生提交去重与 checkpoint 保持不变。

## 停止、失败与重启

普通停止取消主会话当前非 background 工作及未应用输入，子任务继续；重复停止请求仍绑定原目标，不影响后来执行。主模型失败收尾也不取消独立子任务。

指定子任务停止会使取消 epoch 前进、撤回 root 中该任务尚未处理的报告，并调用子 conversation.abort 撤回待应用输入、取消当前执行。迟到报告不再唤起 root；已经被主 Agent 处理的结果无法撤回。stop 必须指定具体子任务，不提供批量停止。子任务失败私下回传失败原因，其他任务继续，主 Agent 决定是否告知用户。

启用调度前检查原生任务：撤回遗留未应用输入，取消主/子不确定执行；只保留未被请求取消、已经完成回答的 Reporter report 阶段，随后 resume 递送结果。保存历史及子会话，显示重启中断提示，不自动重放模型请求、bash 或其他不确定副作用。关闭 Harness 保留原生阶段，重开统一执行此策略。

原生去重保证重复递送同一身份不重复接纳；它不保证外部工具副作用或 TG 网络发送恰好一次。

## 验证状态与限制

五个工具在隔离工作区中覆盖了列表、状态查询、接纳、继续、停止、权限隔离和持久化恢复。验证不调用真实模型供应商或 Telegram Bot。

任务执行与普通后台委派共用运行时，见[任务与执行记录](tasks.md)。普通后台委派没有独立管理界面或自动续跑能力；并发/成本限额与可靠平台 outbox 尚未实现。旁聊委派受发起旁聊的 owner 范围约束，报告只回原旁聊。
