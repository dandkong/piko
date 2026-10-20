# 定时事项

状态：首版代码已接入，自动化与真实浏览器的临时 faux 模型联调已验证；真实模型、Telegram Bot 与原生设备体验仍需验证。实现采用简化方案，并按用户决定复用普通子 Agent 的结果回传：**完成后私下交回主 Agent，由它整理和回复**，不直接发布另一套通知。

## 范围

一个事项（WorkItem）就是一个 Prompt、一条可选时间规则、一个固定目录。不拆 Goal / 执行计划，不增加多计划工作流；每次执行创建一个新的 owned 子 conversation，不 fork 主聊天历史。全局模型、思考强度、指导与技能共用，子 Agent 移除 subagent 和 work_item，不能嵌套委派或创建调度。

Tasks 导航已启用，只展示 Piko 在替用户做的事：列表仅显示未归档事项，展示名字、人话时间与上次结果摘要；每条前面一个方框用来归档，归档后从 UI 隐藏，但定义和执行历史仍保留，助手可恢复。详情页只读，是说明与结果时间线。写入都在对话里：用户在 Chat 里说做什么，主 Agent 创建、执行、恢复或停止；页面不提供创建、执行、暂停或恢复入口，人只看和归档。页面不提供标题/Prompt/Cron/时区表单、编辑、执行 ID、版本、事项记忆或产物文件浏览；这些属于助手和运行时，不暴露给用户。Chat 保持挂载以保留草稿和历史位置；Posts、Artifacts 与其他占位仍禁用。Tasks 进入页面读取一次，回前台刷新一次，不轮询、不增加任务 SSE 或持久事件日志，也不自动提交执行。

## 数据与事实源

`shared/work-items.ts` 是普通跨端契约，SDK 细节留在 `server/runtime/`。

```ts
type ItemSchedule = null
  | { type: "once"; at: number }
  | { type: "cron"; expression: string; timezone: string };

type WorkItem = {
  id: string;
  title: string;
  prompt: string;
  schedule: ItemSchedule;
  scheduleText?: string;
  status: "active" | "archived";
  revision: number;
  createdAt: number;
  updatedAt: number;
  nextDueAt: number | null;
};
```

- WorkItem ID 由应用分配 UUID；执行 ID 使用原生子 conversation ID，以不透明字符串跨端。
- `scheduleText` 是助手写入的一句话时间标签（如“每天 9:00”），界面只展示它，从不解析 Cron；缺省时按规则退化显示。代码不改写、不清洗模型输出；只在工具说明里要求写成本地人话、不带时区与 Cron。
- 执行投影带 `preview`，由最终回答截取，列表用一句话交代上次做了什么。
- root 的原生 `piko.work-items` 文档保存定义、版本、游标与经验证的结果通道来源。
- `piko.item-command` 原生文档保存稳定管理请求的内容指纹和实体引用。重复请求返回原结果；同 ID 不接受不同命令。不保存第二套消息正文或执行状态。
- 子会话的 `piko.item-context` 只保存事项关联、定义版本、标题快照、计划/启动时间和重启中断来源。
- 执行 Prompt 快照保存在原生 Reporter input；子 Agent 实际收到的 Prompt 带本次工作说明。
- 执行状态从 Reporter、submission、LiveDoc 和取消 epoch 投影。Reporter 完成不等于子工作成功；失败 submission 仍显示失败。Reporter 终态只增加原生回答 entry / 错误引用，不复制回答正文。
- UI 的“已完成回答”表示模型完成输入，不声称用户目标已被确定性验收。缺输入等语义阻塞目前由主 Agent 从回答中处理，没有新增 blocked/approval 工作流。

事项的管理状态和一次执行状态分开；一次性触发完成后保留事项，可继续手动执行，不自动归档。

## 目录与记忆

```text
workspace/items/<事项ID>/
├── MEMORY.md
└── outputs/<执行ID>/
    └── report.md
```

新建事项幂等准备目录和记忆文件；Reporter 在子输入提交前准备输出目录。只创建缺失内容，标题修改不改路径。

子 Agent cwd 是事项目录；全局指导/记忆/技能依然从原本显式资源根加载，额外注入当前事项 MEMORY.md（最多 4,000 字节）。历史产物按需读取，不把所有执行历史注入上下文；任务说明要求保守维护事项记忆、不修改全局指导和记忆。

这不是权限沙箱。read/write/edit/bash 仍以后端进程权限运行，记忆写入也没有事务回滚。敏感工具授权、环境隔离、共享浏览器互斥及更完整的记忆审批/遗忘治理仍是后续独立能力，不由目录和提示词保证。

事项记忆和 `outputs/` 属于助手的工作文件：子 Agent 用它们维持连续性和交付产物，界面不读取、不预览、不提供文件接口。

## 调度规则

调度器在当前 Bun 后端每秒检查到期定义，Croner 10.0.1 只做时间计算，不启用自己的任务计时器。后端必须在线；客户端关闭不影响执行。

- 手动：schedule=null，没有自动触发。
- 一次性：at 为 Unix 毫秒；过去的时刻延迟补执行一次。接纳原生任务与将 nextDueAt 清空在同一 commit 完成。
- Cron：五段表达式和明确的 IANA 时区，只在存储与调度内部使用；用户只看到 `scheduleText` 这样的人话标签。时区/夏令时按锁定 Croner 行为计算；例如纽约春季不存在的 02:30 会规范化到 03:30，本项目不另外实现另一套时区算法。
- 离线漏掉多轮 Cron：只启动最近到期的一轮，并推进到下一个未来时刻。
- 同一事项只允许一个执行。停止先使回传失效，但只要原生 LiveDoc 仍有工作就继续占位，避免取消未收尾时启动新执行。
- 周期到期遇到同事项忙碌：跳过这轮、推进游标，不建立积压队列。一次性到期遇忙碌则保留到期状态。
- 同时最多两个事项执行。手动超额返回 409；定时超额保留到期状态，容量释放后再检查。这个上限不改变普通 subagent 的现有并发行为。
- 暂停由归档代替：归档只停止自动触发，不取消正在执行子 Agent；恢复由助手在对话中完成。
- 恢复 Cron 从未来下一时刻开始，不补归档期间的全部轮次；恢复尚未接纳的一次性任务可以延迟执行。
- 停止必须指定本次执行 ID，不影响未来时间规则。重复停止只作用于原子回执记录的原目标。
- 归档前要求先停止执行，归档后不接纳新执行，文件和历史保留；可恢复。
- Prompt/标题修改不重新触发已接纳的一次性规则。时间规则真正变化才重新计算游标；当前执行继续使用原始快照。更新需要当前 revision，陈旧编辑返回 409。

不是实时监控，也不承诺分秒不差。暂不实现自动重试整个任务、执行预算、连续失败暂停或复杂工作流。模型内部重试仍沿用 Durable 默认策略。

## 回传、通道与停止

复用现有后台 Anchor/Reporter：调度直接建立子工作，不先唤醒主 Agent 来转述；结果再以可信内部 follow-up 提交到 root，主 Agent 忙碌时等待当前回答结束。事项标题、执行身份和输出目录附在内部回传中，主 Agent 决定回复、继续整理或保持安静。

- 普通主聊天停止不取消独立事项执行；Tasks 的停止操作与 work_item stop 只取消指定子工作，并撤回其未处理的内部报告。
- UI/RN 创建的定时事项默认来源为 app，不额外向 TG 投递。
- 经 TG 主 Agent 创建的事项保存已验证 Bot/chat 来源；之后定时回传先重新挂接主回复观察，仍只发送主 Agent 的实际回复。UI 手动运行则以本次 app 来源回传。
- 不给子 Agent 开放调度管理，普通 subagent.send 不能改变事项执行的固定 Prompt 快照；修改事项或再启动一次。
- 不建立通知 outbox，不保证 TG 恰好一次送达或重启补发。

## 重启

先执行既有 prepareRestart，再启用调度器：不确定的主/子执行被取消，不重跑 bash、模型或已经接纳的一次性触发；事项关联保留 interrupted 标记供 UI 展示。已经完成且 checkpoint 位于 Reporter report 阶段的结果可恢复纯回传。

启动同步模型、工具与扩展时保留事项 cwd，不能重置为 root 目录。未接纳的过期时间规则仍可延迟启动，这与重放中断执行不同。退出先停止新调度、等待当前到期检查，再关闭 Harness。

## HTTP 与工具

| 接口 | 行为 |
| --- | --- |
| GET /api/items | 事项列表和最近执行投影 |
| POST /api/items | 带 requestId 的 create/update/status/run/stop 命令，返回实体引用和 duplicate |
| GET /api/items/:id | 定义、最近 50 次执行和 nextBefore；不返回事项记忆 |
| GET /api/items/:id?before=:executionId | 更早一页执行 |
| GET /api/items/:id/executions/:executionId | 本次执行的状态与最终回答 |

模型内建 work_item 的 list/get/create/update/run/archive/restore/stop 与 UI 使用同一个业务服务。create 默认手动，并应携带 `scheduleText`；update 必须显式携带完整 title/prompt/schedule 和当前 revision，避免意外移除定时。UI 只归档，不创建、不编辑、不恢复，也没有文件接口。工具身份由原生 tool task 分配，不接受用户伪造内部来源；已取消的管理工具不能再接纳新事项执行。

## 验证与未验证范围

自动化覆盖：定义持久化、命令去重和冲突、过期版本、Cron/时区、一次性只执行一次、Cron 漏轮合并、同事项互斥、归档门禁与恢复、停止重投不误停新工作、原生失败投影、事项记忆与独立产物的路径边界、主聊天隐藏内部输入、TG 来源、重启中断与完成结果回传恢复、HTTP 校验。

Web/iOS/Android 生产 bundle 已导出到临时目录，不覆盖正式 Web 构建。真实共享 Chromium 中，用临时 PIKO_HOME 和 faux 模型走通在 Chat 创建任务、Tasks 查看结果与展开时间线、返回 Chat 查看主 Agent 整理回复；测试标签已关闭，已有用户标签保留。

未用真实付费模型或真实 TG Bot 进行本功能验收，iOS/Android 未安装真机验证；没有重启或部署正式服务。后续应验证真实模型能否合理维护事项记忆、稳定保存产物，并检查移动端键盘、后台恢复和 TG 实际投递体验。
