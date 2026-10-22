# 任务与执行记录

状态：已实现。任务支持手动、一次性和周期执行；用户在 Chat 里交办，Tasks 页面查看和归档。真实模型、Bot 与原生设备体验仍需使用验证。

## 名称与边界

- **任务（AssistantTask）**：保存完整指令、可选时间规则和展示标签，可反复运行，拥有固定目录和任务记忆。不是只有定时任务。
- **后台工作**：主助手直接委派出去的工作，可以补充指令、查看状态、停止或继续；技术层保留 subagent 名称。
- **执行（TaskExecution）**：任务实际运行的一次过程，每次创建新的 owned conversation；不 fork 主聊天历史。
- **归档**：任务停止未来触发，保留定义、目录和执行记录；恢复后重新启用未来触发，不立即执行。
- 任务的“进行中／已归档”与一次执行的“运行中／已完成／失败／已停止／已中断”分开，归档不叫完成。

## 产品交互

Tasks 列表按“进行中／已归档”分组，标题常驻可折叠，进行中默认展开、已归档默认收起。条目只显示名字和人话时间，不显示执行状态、上次结果或下次触发时间。左侧归档／恢复图标操作任务生命周期，不再使用完成勾选；读屏说明归档会停止未来调度。正在执行的任务不能归档，先在聊天中停止执行。

详情只读，展示任务说明、时间标签和已结束的执行记录。记录最新在上，有摘要可展开运行结果；失败只展示状态，不暴露原始错误。运行中的执行不进入时间线，重新进入页面或回前台时刷新。没有执行时明确显示“还没有执行记录”。

创建、编辑、运行、停止在对话里完成；页面仅提供归档和恢复，不提供创建/编辑/运行表单、Prompt/Cron/时区表单、执行 ID、任务记忆或文件浏览。Chat 保持挂载以保留草稿和历史位置。页面进入和回前台时各读取一次，不轮询、不增加任务 SSE，不自动提交执行。

## 类型与代码边界

`shared/tasks.ts` 是普通跨端契约，不依赖 SDK：

```ts
type TaskSchedule = null
  | { type: "once"; at: string }
  | { type: "cron"; expression: string; timezone: string };

type AssistantTaskDraft = {
  title: string;
  prompt: string;
  schedule: TaskSchedule;
  scheduleText: string;
};
```

领域类型使用 `AssistantTask`，避免与 Durable 原生 task 混淆。`TaskExecution`、`TaskSchedule` 表示业务执行和调度；原生 `TaskId`、`TaskRecord` 保留 SDK 命名。工具 create/update 的四项定义字段全部必填，包括 `scheduleText`；展示标签不决定实际执行时间。

| 文件 | 职责 |
| --- | --- |
| `server/tasks/http.ts` | 任务 HTTP 输入校验和服务调用 |
| `server/domain/tasks.ts` | 任务定义、时间规则和目录边界 |
| `server/runtime/assistant-tasks.ts` | 定义、游标、命令幂等、调度、执行投影 |
| `server/runtime/task-tools.ts` | `task_*` 模型工具入口 |
| `server/runtime/subagent-runtime.ts` | 两类工作共用的 Anchor/Reporter、创建、继续、取消、回传与恢复 |
| `server/runtime/subagent-tools.ts` | 普通委派的 `subagent_*` 模型工具入口 |
| `server/runtime/background.ts` | 后台模型、继承工具范围和子会话创建策略 |

任务服务依赖共用执行模块，不依赖普通委派工具。子会话及旁聊移除全部 `task_*`、`subagent_*`，工具执行处另检查 root 权限，不能嵌套委派或创建调度。

## 持久化与目录

任务 ID 是 UUID，执行 ID 使用原生子 conversation ID，跨端视为不透明字符串。定义/调度游标和请求回执保存在原生 doc，状态从原生 Reporter、submission、LiveDoc 投影；不建立 Run 表、状态副本或第二套消息正文。

本轮是业务名称和模块边界调整，存储结构不变：继续使用 `piko.work-items`、`piko.item-command`、`piko.item-context`、绑定字段 `itemId` 以及 `items/<id>/`。它们是固定持久化身份，不是旧接口别名；不存在新旧双读、迁移分支或兼容工具。已有 Durable 数据可原样重开；实测发现一条归档的一次性任务缺少展示标签，已原位补正，未清理任何数据。

```text
workspace/items/<任务ID>/
├── MEMORY.md
└── 本次及历史执行的产物
```

每次执行使用任务目录作为 cwd，加载本任务记忆，直接保存产物；主助手仍可读取整理。不能修改全局指导或全局记忆，目录约定不构成安全沙箱。文件 API 拒绝逃逸、符号链接等越界路径。

## 时间、并发与幂等

- `schedule:null` 为手动任务；once 是带显式 offset 的 ISO 8601 时间；cron 必须为五字段表达式和 IANA 时区。人话 `scheduleText` 仅用于展示。
- once 执行后清空下次触发游标；cron 用 Croner 计算时间，运行时只保留一个调度检查，不另起定时器体系。
- 手动 run 不改变调度。每项任务最多一个执行，全局最多两个任务执行，不改变普通委派的并发策略。
- 手动超额返回冲突；调度超额保留到期状态，容量释放后重查。cron 运行中到期时推进游标，避免重复积压。
- update 完整替换定义，先 get 再保留未修改字段；不改变已运行执行的指令快照。调度变更才重算游标。
- 管理命令用 requestId 和内容 hash 去重。同一身份内容不同报错；重复停止仍绑定原始执行，不影响后来的执行。
- 归档前必须停止运行；恢复 cron 重算未来时间，不立即执行。

## 回传与恢复

后台执行复用 Anchor/Reporter，结果以可信内部 follow-up 交回主助手，由它决定回复、继续整理或保持安静。任务执行不论创建或手动运行来源，结果都广播到所有通道；普通后台工作只回复来源通道。子会话原文不直接发布。

主聊天普通停止不影响独立工作。`task_stop` 取消该任务当前执行并撤回未处理报告，不改未来调度；`subagent_send` 不得更改任务执行的固定 Prompt 快照。任务失败不会自动重试整个执行。

启动时撤回遗留未应用输入并取消不确定执行，标记中断；仅恢复已完成回答的报告阶段，不重跑模型和外部副作用。没有可靠平台 outbox，不承诺 TG 恰好一次投递或重启补发。

## HTTP 与工具

仅提供新接口，不保留 `/api/items` 或 `work_item_*` 别名。

| HTTP | 行为 |
| --- | --- |
| `GET /api/tasks` | 返回 `{tasks:[...]}` |
| `POST /api/tasks` | create/update/status/run/stop；定义字段名为 `task` |
| `GET /api/tasks/:id?before=:executionId` | 返回 `{task, executions, nextBefore?}`，执行每页最多 50 条 |
| `GET /api/tasks/:id/executions/:executionId` | 执行状态及最终回答 |

| 工具 | 参数与行为 |
| --- | --- |
| `task_list` | 可选 `includeArchived`，默认只列活动任务，不返回 Prompt 正文 |
| `task_get` | 必填 `id`，完整定义和最近五次执行 |
| `task_create` | title/prompt/schedule/scheduleText 全部必填，手动任务也显式提供 null 与标签 |
| `task_update` | id 和四项完整定义必填，先 get 再更新 |
| `task_run` | id，立即执行一次，不改调度，结果自动回传，不轮询 |
| `task_stop` | id，停止当前执行，不改未来调度 |
| `task_archive` | id，归档、停止未来触发，不删除 |
| `task_restore` | id，恢复活动状态和未来触发，不立即执行 |

UI 和工具共用同一业务服务。工具身份由原生 tool task 分配，不接受伪造内部来源；已取消工具不能再接纳新任务执行。工具说明只保留用途与关键边界，参数约束交给 schema。

## 验证边界

本轮使用隔离工作区、真实 Harness 和 Faux provider 验证：新工具目录及旧名拒绝、定义字段必填、创建/更新/执行/停止/归档/恢复、任务目录、原生结果回传、旁聊和子会话工具隔离、持久化重开。已有 Durable 数据可原样重开，不需要清库或兼容层。

Web 和 iOS bundle 已导出到临时目录，并用共享 Chromium 验证“进行中／已归档”、归档移组、恢复回组、执行记录和展开运行结果；使用临时 PIKO_HOME 与 Faux provider，保留用户原有浏览器标签。未使用真实付费模型或真实 TG Bot 验收，iOS/Android 视觉、读屏、前后台行为仍需真机验证。
