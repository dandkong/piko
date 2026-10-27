# Agent 构建与后台执行

状态：内部构建接口、显式资源策略和后台执行机制已分离。普通委派和保存任务仍使用现有工具及产品行为；选择技能子集、无自动资源和原生 fork 仅为内部能力，没有新增模型工具参数或配置 UI。

## 分层

| 位置 | 职责 |
| --- | --- |
| `server/runtime/agents/create.ts` | 按调用者提供的 Agent 配置、资源策略和历史起点创建 owned conversation；使用 Durable 原生 create/fork 与 configure |
| `server/runtime/agents/resources.ts` | 自动注入的 core、工作区指导、记忆文件和技能索引策略；不保存文件正文 |
| `server/runtime/resources.ts` | 每次模型请求依据资源策略读取文件和发现技能，生成动态 section |
| `server/runtime/subagents/runtime.ts` | Anchor/Reporter、输入提交、等待回答、取消、去重和经父会话接纳线回传；不读取任务定义或任务目录 |
| `server/runtime/subagents/queries.ts`、`recovery.ts` | 共享原生执行事实与不重放恢复；不依赖保存任务业务 |
| `server/runtime/subagents/delegations.ts` | 普通委派的默认角色、技能范围、继续规则、归属检查和列表/状态投影 |
| `server/runtime/tasks/agent.ts` | 保存任务的目录准备、任务记忆、固定执行 Prompt、结果来源说明及绑定；调度仍在任务服务 |
| `server/runtime/memory-curation.ts` | 复用 Agent 构建，但保留专用 Durable 整理流程，不强制走 Reporter |

## Agent 配置与历史起点

`ChildAgentSpec` 显式提供 model、thinkingLevel、cwd、instructions、extensions 和 tools，以及独立的资源策略。创建时清除未显式指定的 `modelTools` 过滤器，避免继承父会话的隐藏选择。实际值只保存在 Durable `AgentDoc`，不建立第二份 Agent 配置。

- 没有 `history`：新建空历史的 owned conversation。
- 提供 `{ conversationId, at }`：使用 `tx.forkConversation`，从明确的原生 entry 边界继承历史。随后应用调用者提供的 Agent 配置和资源策略。
- fork 不复制消息正文，不继承 fork 点后的输入、执行或取消状态。原生文档遵循各自的 fork 语义；Piko 的资源策略、回报策略和取消控制都使用 `fork: initial`。
- fork 后禁用资源注入不等于移除继承历史里已有的指导、记忆或技能正文。需要干净上下文时必须从空白会话开始。

## 动态资源策略

原生文档 `piko.agent-resources` 只保存资源选择：

- `core`：是否注入内建核心指导。
- `guidance`：是否注入工作区 `AGENTS.md`。
- `memory`：需要自动注入的明确文件路径列表。
- `skills`：`"workspace"` 表示工作区/内建技能索引，名称数组表示白名单，`[]` 表示不提供技能索引。

这些选择相互独立，不再由 `isSubagent` 或是否绑定任务间接推导。尚未初始化资源策略时默认不注入资源。只加载显式文件，不发现祖先指导；技能只注入名称、描述和路径，正文按需读取。文件仍完整读取，拒绝指导文件及其父路径中的符号链接。

当前业务默认值：

| 场景 | 历史 | core / AGENTS | 自动记忆 | 技能 |
| --- | --- | --- | --- | --- |
| 主会话、旁聊 | 自己的历史 | 有 | 全局 MEMORY.md | 工作区/内建索引 |
| 普通委派 | 空白；继续时复用自己的历史 | 无 | 无 | 工作区/内建索引 |
| 保存任务执行 | 每次空白 | 无 | `tasks/<id>/MEMORY.md` | 工作区/内建索引 |
| 记忆整理 | 明确输入选定聊天片段 | 无 | 无，按任务指令读取 | 无 |

## 执行与回报

共享 runner 接受已经组装好的 Agent、输入和回报策略。创建时的输入/回报构造函数只在当前事务运行，保存到 Reporter 和元数据的是解析后的文本与普通 JSON，不持久化回调。

`piko.background-job` 保存用途标签、是否允许继续输入以及回报来源标题/投递提示，不保存执行状态或回答正文。普通委派可继续；任务执行使用固定输入。普通委派工具按用途和 owner 校验，不能越过业务边界操作任务执行或其他用途的 Agent。

Reporter 保留稳定 requestId、answer entry 引用、取消 epoch 和父会话接纳边界；回报正文仍从原生回答读取。任务专属的目录准备、Prompt 和记忆由 Tasks 负责；运行时装配处将任务目录检查注册为通用输入前置检查，失败结算为该次执行失败，不回滚调度游标或反复触发同一次计划。主会话 `/stop` 不停止独立后台工作，显式取消会撤回未处理报告；已经应用的报告和外部副作用不回滚。

## 重启与默认模型

后台默认模型在新建子会话时解析。已有子会话的模型、cwd、角色、工具和资源选择在原生文档中保留；重启不重新套用父会话模板，也不因修改 `profiles.background` 而覆盖它们。普通委派继续使用已有选择；任务下次执行创建新会话，使用当前默认配置。

启动时只初始化缺失的业务/资源策略元数据，保留已确定的选择。重启先取消不确定执行、撤回遗留输入，再恢复已完成结果的 report/retry 阶段；不重放模型、工具或 shell 副作用。

## 隔离边界与验证

资源策略只是上下文选择，不是安全沙箱。不注入技能不阻止有 `read`/`bash` 的 Agent 访问技能文件；独立 cwd 不限制绝对路径。当前执行环境仍使用本机权限并继承后端环境。文件、网络及凭据隔离需要独立的执行环境和权限方案，不属于本次内部构建接口的保证。

隔离 faux 模型验证覆盖空白上下文、独立指导/记忆选择、技能白名单与无技能、原生 entry-based fork、固定输入限制、任务目录和记忆、主/旁聊报告归属与继续、取消/删除、定制 Agent 重启保留、已完成结果回传恢复不重跑子任务，以及记忆整理无自动资源；目录前置检查失败时一次性计划只产生一条失败记录。任务永久删除回归覆盖 SQLite 完整性、敏感 Prompt 擦除和清理中断恢复。未调用真实付费模型或真实 Telegram Bot，也未实现 OS 级沙箱。
