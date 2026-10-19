# 后台子 Agent

状态：已实现并通过原生 faux 模型和模拟 TG 自动化。只接入后台委派，主 Agent 继续交流；子 Agent 不嵌套、不单独展示。结果私下交回主 Agent，由它决定继续工作、回复用户或保持安静。真实模型与 Bot 行为仍需验证。

## 共享资源与会话

主、子 Agent 共用同一个 Harness、JSONL 存储、模型与思考强度、基本工具、内建扩展、技能、全局 AGENTS.md 和 MEMORY.md。普通委派共用工作区，没有独立配置或记忆目录；子工具移除 subagent 和 work_item，同时在工具执行处拒绝非 root 的委派/事项管理。子角色说明只补充任务职责，仍加载共享指导。

[定时事项](scheduled-work-items.md) 复用相同 Anchor/Reporter 和回传机制，但使用固定事项目录作为 cwd，并额外加载本事项记忆、保存独立输出。本文其余共享文件与不增加展示的约定针对普通聊天委派；Tasks 页面单独展示事项执行记录，不把内部子消息投影到主聊天。

每次 spawn 创建新的原生 conversation；完成后保留历史，新任务重新 spawn。send 只给仍在执行或等待输入递送的子任务补充要求，不重新启用已结束会话。不建设用户会话列表或切换入口，与未来的用户 side chat 分开。

子会话直接新建，不 fork 或继承主聊天历史。只加载共享指导、记忆、技能和工具，以及本次委派任务；所需额外背景由主 Agent 明确写入 task。任务由 Reporter 单独提交，子执行不实时回灌 root；工具、压缩和回答保存在子 conversation 中。UI 只投影 root 的完整历史。

改变模型和思考强度时同步所有已创建子会话；已经准备的模型请求继续完成，后续请求使用新选择。重启时同步当前主 Agent 的模型、cwd 与工具选择。配置仍需重启生效；指导和技能索引按每次模型请求刷新。

共享文件并发修改由主 Agent 分工协调，不强制独立 cwd 或 artifacts 目录。本机权限与当前基本工具一致，cwd 和提示词不是沙箱。

## 委派与回传

主 Agent 使用内建 subagent 工具，不增加 HTTP 管理 API 或 TG 命令：

| action | 行为 |
| --- | --- |
| spawn | task 必填；创建新子会话，立即返回原生会话 ID，不等待结果 |
| send | id、task 必填；补充正在运行的子任务，默认 steer；followUp:true 则下一回合处理 |
| status | 返回原生执行状态；可指定 id，否则查询已有子任务 |
| stop | 指定 id 取消该子任务；省略 id 停止当时所有子任务，不停止主 Agent |

普通用户输入仍进入主会话，维持 steer all，不广播给所有子 Agent。报告以内部 input、whenBusy:followUp 回传：主 Agent 空闲时唤起处理，忙碌时等待当前回答结束。报告不是新的用户指令，不强制生成完成通知。

RN/Web 和 TG 不显示子 Agent 消息、工具过程、状态卡片或内部报告气泡。可信来源由运行时原生文档记录，历史和 queued 输入都按该来源过滤；外部 requestId 禁用 piko: 命名空间，正文写成“内部报告”仍是普通用户消息。

TG 来源的委派记录经过验证的 Bot/chat 来源，在回传前重新建立 root 回复观察。只发送主 Agent 实际生成的文字，主 Agent 保持安静时没有通知；RN 来源不额外推送 TG。Rich Markdown 和按助手消息独立投递保持原样。平台状态在内存，不保证重启补发或恰好一次送达，原生历史仍可查看。

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

两个原生文档只补充产品所需元数据：piko.input-origin 保存通道来源、内部报告标记及关联子会话；piko.subagent-control 保存显式取消的 epoch 和已报告 answer ID。执行状态仍以 Durable 为准，不保存状态副本。短暂的内存串行接纳保证报告提交与显式取消有序。

## 停止、失败与重启

普通停止取消主会话当前非 background 工作及未应用输入，子任务继续；旧停止身份仍绑定原目标，不影响后来执行。主模型失败收尾也不取消独立子任务。

指定子任务停止会使取消 epoch 前进、撤回 root 中该任务尚未处理的报告，并调用子 conversation.abort 撤回待应用输入、取消当前执行。迟到报告不再唤起 root；已经被主 Agent 处理的结果无法撤回。stop 不带 id 时仅针对当时已有子会话。子任务失败私下回传失败原因，其他任务继续，主 Agent 决定是否告知用户。

启用调度前检查原生任务：撤回遗留未应用输入，取消主/子不确定执行；只保留未被请求取消、已经完成回答的 Reporter report 阶段，随后 resume 递送结果。保存历史及子会话，显示重启中断提示，不自动重放模型请求、bash 或其他不确定副作用。关闭 Harness 保留原生阶段，重开统一执行此策略。

原生去重保证重复递送同一身份不重复接纳；它不保证外部工具副作用或 TG 网络发送恰好一次。

## 验证与后续范围

自动化覆盖资源共享、禁止嵌套、主助手继续交流、共享选择、独立停止、排队报告撤回、多 steer 回答去重、失败隔离、隐藏输入防伪、重启中断与完成结果恢复，以及空闲后的 TG 回复、静默处理和 RN 来源不推 TG。

依据本地 pi-mono 的 [后台委派示例](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/23-subagent-background.ts)，实施对照锁定的 durable 1.1.0 类型；本地 main 示例的 output、abandonOnRestart 不直接照搬。

事项调度与 Tasks 首版见 [定时事项](scheduled-work-items.md)。普通委派的并发/成本限额、可靠平台 outbox，以及用户 side chat 的入口、共享背景和结论回传仍待设计；普通委派没有独立管理 UI，也不自动续跑未完成执行。
