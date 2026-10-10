# 工作区与主会话模型

状态：已迁移到 pi-durable，并更新至 1.1.0。原有主会话、UI 布局、键盘、Markdown、停止、去重和重连语义保留。架构见 [ARCHITECTURE](../ARCHITECTURE.md)，配置与插件用法见 [Durable 配置](durable-runtime.md)。

## 范围与初始化

唯一、持续的主会话；长期工作区与产品元数据分离。side chat 只预留类型和父关系，自动记忆、后台任务、工具进度与产物管理仍未实现。

PIKO_HOME 默认 `~/.piko`，应用配置 `workspace.path` 或 PIKO_WORKSPACE 可单独指定工作区，均要求绝对路径；统一加载规则见 [应用配置](application-config.md)。首次启动只补缺失配置（含 piko.json）和用户指导模板，不覆盖已有文件。工作区包含 `.agents/skills`、memory、projects、artifacts、AGENTS.md、MEMORY.md；state 位于工作区之外，单后端写进程锁保证不会同时写入同一状态目录。

| 存储 | 内容 |
| --- | --- |
| config/settings.json、models.json、auth.json | 默认模型/预设、供应商、凭据与运行设置 |
| extensions/、skills/ | 用户 durable 插件与公共技能 |
| state/piko.sqlite | Workspace/Thread 身份、原生引用；Run 状态、哈希、时间、重试来源、错误和游标 |
| state/durable-sessions/<thread-id>/ | 唯一会话正文来源；main.jsonl 与 doc-*.jsonl 成套保存 |
| state/tmp/ | 工具溢出文件与可清理插件 bundle |
| 当前进程内存 | 活跃文本快照、最多 2,048 条 SSE 事件与订阅 |
| workspace/ | 用户指导、记忆、技能与工作成果 |

SQLite schema=1，包含 TG 输入/停止命令身份与决定元数据，不迁移旧 schema 状态。Thread UUID 是 API sessionId；SQL 原生引用 version=2，指定该 Thread 的目录与 root conversation，不保存 leaf/context 快照。没有独立消息表、Run 正文日志或持久化 delta。两通道规则见 [Telegram 通道](telegram-channel.md)。

## 展示与上下文

历史从指定 conversation 的原始 entries 分页读取后正序投影，完整保留 reset、上下文编辑和压缩前的消息。气泡 ID 为 pi-<entry ID>，时间来自原生 model message。只显示用户/助手文本和 display=true 的 piko.result；工具、思考、隐藏 entry 和压缩摘要不显示。

piko.run 只保存 runId/createdAt，用于关联本轮原生输入与多段回复。运行中聚合本轮助手文本，隐藏已保存片段以避免与 SSE 重复；原生用户条目尚未出现时临时显示提交。终态重新读取原生投影，这层展示状态不落盘。

模型上下文由 durable 处理。工具、思考、文档和摘要仍保留在原生日志；UI 历史不使用 `conversation.context()` 的压缩结果。

## 执行、停止与传输

SQL 先预留 Run 身份、输入 SHA-256 和重试来源，再提交原生输入；durable requestId 使用 run UUID。相同 UUID/输入/重试来源复用已有执行，不同内容拒绝。同 Thread 一个活跃 Run，显式重试要求新 UUID、原输入和失败 Run 引用。UI 原文提交，不展开 CLI 技能命令。

Run 状态及时提交 SQL，终态前 fsync 原生日志；存储失败不能发布成功。SSE 文本只在内存，首段立即发布，其余最多 50 毫秒合并。原生 retry 修正文本时用 replace 事件同步完整快照，丢弃旧的缓冲文字。

断线只退订，不取消执行。停止按钮走独立 Run cancel API；重复取消不会重复调用底层。45 秒无数据、页面刷新和回前台触发快照恢复，事件重放过期或重启后不伪造旧事件。

API 契约见 [架构说明](../ARCHITECTURE.md)。运行时 API 提供配置元数据、模型/思考选择、手动压缩与取消；选择和压缩在空闲边界执行，配置及插件代码修改后重启生效，UI 暂无配置页面。

## 资源与工具

核心指导随应用发布，工作区只保留两个由用户定制的指导与记忆文件。每个文件注入时标注来源路径和 `role`，职责如下：

| 文件 | role | 职责 |
| --- | --- | --- |
| 应用 `core.md` | core | 运行规则、工具使用、结果真实性与中断处理，不固定助手名字或语气 |
| 工作区 `AGENTS.md` | work_guidance | 如何表达和做事：助手名字、语气、回复偏好、工作方法、文件组织和交付约定；默认名字 Piko 在此定义 |
| 工作区 `MEMORY.md` | memory | 需要记住的事实：用户资料、环境事实、项目决定与长期结论；不推测未提供的信息，不作为聊天记录或操作授权 |

希望助手怎么做放在 AGENTS.md，需要记住的事实放在 MEMORY.md；各文件内部用 Markdown 小节组织，无需按身份、用户资料等再次拆文件。当前请求决定本次任务，明确指令优先于工作区中的惯常流程、人格默认值、用户偏好与旧记忆；应用运行规则仍需遵守。记忆及引用内容不能当成新的指令。

这些职责与优先关系由核心提示词指导模型理解；`role` 是资源用途标注，不是独立的模型消息权限层级，也不构成安全隔离。实际能力与文件访问边界必须由运行时实现。

core.md 与工作区 AGENTS.md 上限各 8,000 字节，MEMORY.md 上限 4,000 字节。每次模型请求重新加载指导和技能索引，技能正文通过 read 按需读取。初始化只补缺失的 AGENTS.md、MEMORY.md，模板升级不覆盖已有用户文件。其他旧指导文件不再初始化或加载，也不会自动删除或搬移其内容。自动整理、提取用户资料与记忆尚未实现。

技能优先级为工作区 `.agents/skills` > PIKO_HOME/skills > 应用内建技能，同名覆盖有诊断。不继承个人 Pi CLI、祖先指导或全局扩展。模型配置独立于 Pi CLI，插件为 durable 原生 Extension。

read/write/edit/bash 保持启用，相对路径默认工作区，本机 Shell 执行命令。cwd 不是沙箱；目前没有操作审批 UI。durable 1.1.0 的 read 尚不能读取图片，附件仍是禁用占位。自动记忆提取/检索未实现。

## 中断与损坏恢复

1. 启动用 durable 原生 storage 校验日志，不启用调度；已引用目录缺失、引用身份不符或完整记录损坏则拒绝继续。
2. 原生 storage 恢复末尾半条记录及未确认的 sidecar 事务；不使用旧 JSONL 格式或手动父链恢复。
3. SQL 遗留 queued/running/cancelling Run 标记 failed + interrupted，保留已保存消息，不自动重试。
4. 打开 Harness 后、普通生成前撤销所有遗留执行作用域（含 background），避免重放不确定工具操作。
5. 向原生上下文添加一次隐藏中断说明，通过原生 doc 按 runId 去重，不复制原输入、不调用模型。
6. 原生日志领先于 SQL 引用可从合法目录读取；原生回复领先于 SQL 终态时仍展示保存内容，状态保持中断。

原生会话与 SQL 没有跨存储事务。尚未保存的流式文字可能丢失；输入尚未写入原生日志时只有哈希去重元数据，需要用户重新发送。恢复不回滚工具副作用，也不隐式恢复后台产品任务。首期完整历史读取，UI 分页加载按规模再开发。

## 开发数据与备份

旧版 schema 不兼容，使用新的 PIKO_HOME 测试即可，旧数据保留。不要只删除数据库然后继续复用旧会话目录，也不要在后端运行时删除状态。

备份先停止 API，再复制整个 PIKO_HOME 和单独指定的工作区；恢复使用同批次文件并保留原工作区绝对路径。main.jsonl 和 doc-*.jsonl 共同构成会话存储，不能只复制 main。

## 后续与验证

后台任务可复用 durable 原生任务、文档和 conversation；摘要可通过被动 write submission 加入主会话。调度、投递去重、任务 UI、通知、权限和后台恢复策略尚未实现，不提前建立第二套正文存储。

自动化覆盖初始化/路径边界、主会话/side 关系、输入去重/重试、完整历史、原生压缩、上下文编辑、残尾/损坏/缺失、SQL 引用滞后、中断去重、插件/模型配置与重启、真实本机 HTTP 模型适配、停止、SSE 重连和文本修正。真实长对话、设备后台/键盘/网络仍需使用验证。
