# 工作区与主会话模型

状态：已重构为 Pi 原生会话内容与 UI 投影。自动化检查覆盖持久化、压缩、分支、停止和恢复；真实长对话及设备后台行为仍需使用验证。遵循 [产品约定](../PRODUCT.md) 和 [架构约定](../ARCHITECTURE.md)。

## 范围

唯一、持续的主会话；独立长期工作区；Pi 原生 JSONL 保存所有会话内容，UI 从完整分支投影。保留已有布局、键盘、滚动、Markdown 和流式交互，不维护另一套消息正文或永久 SSE 日志。

已启用 read、write、edit、bash 四个 Pi 内建工具和受控指导/技能加载。side chat 仅预留类型与父关系；自动记忆、工具进度、Activity、产物管理和后台任务未实现。

## 初始化与数据

PIKO_HOME 默认 ~/.piko，PIKO_WORKSPACE 可单独指定，均要求绝对路径。工作区创建 .agents/skills、memory、projects、artifacts 与 AGENTS.md、SOUL.md、USER.md、MEMORY.md 模板，只补缺失文件。state 位于工作区外，一个状态目录只有一个后端写进程。

| 存储 | 内容 |
| --- | --- |
| state/piko.sqlite | Workspace/Thread 身份关系，原生 file/sessionId 引用；Run 顺序、输入哈希、状态、时间、重试来源、错误和状态游标 |
| state/pi-sessions/<thread-id>.jsonl | Pi 原生消息、工具调用与结果、压缩、分支、自定义消息及少量 state-only 执行标记 |
| 当前进程内存 | 活跃 Run 输入与输出快照、最多 2,048 条 SSE 事件、运行时订阅 |
| workspace/ | 用户指导、记忆、技能与实际产物文件 |

没有 state/runs、独立消息表或持久化 delta 表。当前 schema=2，不兼容旧库。输入哈希用于校验提交与重试，不作为正文来源。

Thread UUID 同时是 API sessionId；Pi 自己的 session UUID 保存在引用中。引用没有 leafId：原生已保存的会话内容是权威历史，不再回滚到 SQL 的已提交上下文分支。

## 展示与模型上下文

Pi 原生 piko-run custom 条目只记录 runId，关联随后产生的用户/助手消息。一轮可以产生多条助手消息与工具结果。

历史读取完整选定分支，消息 ID 为 pi-<entry ID>，时间来自原生条目。过滤内部状态、压缩、隐藏 custom_message、工具及思考内容；用户/助手文本直接展示，display=true 的 custom_message 作为助手内容展示。当前没有任务结果专用卡片。

模型上下文继续由 Pi 压缩感知的接口构建。压缩后 UI 保留旧消息；上下文编辑不修改 UI 的原始历史；不把不同分支的全部条目混为一段对话。

活跃 Run 的聚合输出只用于实时显示，隐藏本轮已保存的助手气泡以避免重复；用户条目尚未出现时展示临时提交。执行结束后重新读取原生投影，替换临时气泡；这层投影不落盘。

## 执行与去重

先在 SQL 预留 Run（输入 SHA-256、重试来源、时间与身份），再创建 Agent 并调用 Pi prompt。UI 输入按原文处理，不展开 Pi CLI 技能/模板命令。正文由 Pi 自己写入原生日志；SSE 增量仅保留内存。

同 Thread 只有一个活跃 Run。同 runId 同输入哈希及重试来源返回已有执行，不同输入拒绝。重启后、后续轮次和运行时缓存淘汰后仍去重。显式重试使用新 UUID、相同输入并关联失败 Run。

运行/取消状态及时提交 SQLite；终态先 fsync 原生文件，再提交元数据，最后发布 done/error/cancelled。存储失败阻止发布成功并停止后续执行。流式文字按最多 50 毫秒合并，首段立即发布，不逐段写盘。

## API 与客户端

- GET /api/main 返回 workspace、thread、sessionId，多个客户端共享主会话。
- POST /api/chat 接受 sessionId、runId、message、after?、retryOfRunId?，返回 SSE。
- GET /api/sessions/:id 返回原生历史投影及最近 Run 快照。
- GET /api/sessions/:id/runs/:runId/events?after=N 只重放当前进程事件；过期、越界、进程重启后返回 409，客户端加载快照。
- POST /api/sessions/:id/runs/:runId/cancel 独立停止；断开 HTTP 仅退订。
- 主会话删除与任意客户端 UUID 创建新会话不可用。客户端每次启动发现主 Thread，旧 ID 返回 409。

同进程重连和前台恢复使用内存快照/事件。重启后的终态 Run 从 SQL 元数据与原生消息重建快照，不伪造历史 SSE。输入尚未落到 Pi 的中断 Run 可能没有 message；不会自动重发，用户需重新提交。

## Pi 资源

显式加载工作区 .agents/skills 和应用 server/resources/skills，同名用户技能优先并输出诊断。关闭默认全局/祖先资源、扩展、提示模板、主题和上下文发现，避免继承个人 CLI 或源码指导。

核心指导随应用发布；工作区 AGENTS.md 最多 8,000 字节，SOUL.md、USER.md、MEMORY.md 各 4,000 字节，超量截断并标注。每轮发送前重新读取指导与技能索引，read 按需读完整技能，write/edit 创建技能和文件，bash 执行脚本。

read、write、edit、bash 刷新后仍启用。工具使用本机权限，cwd 是默认目录，不是沙箱。凭据与所选模型沿用独立 Pi profile；原生压缩和有限自动重试开启。自动记忆提取/检索和专门的权限产品流程尚未实现。

## 中断与损坏恢复

1. 主会话原生文件在启动时校验。已引用文件缺失、session 身份不一致、原生父链/内部 JSON 损坏均拒绝继续，不默默开空会话。
2. 最后半条 JSON 先归档为 .torn-<time>，再修复文件尾；完整但损坏的记录不忽略。
3. 遗留 queued/running/cancelling Run 改为 failed + errorCode: interrupted，保留 Pi 已保存消息；未保存流式文字不保证恢复，不自动重跑。
4. 下次创建 Agent，在原生上下文添加一次隐藏的中断说明，按 runId 去重；说明不触发模型调用，也不重复原输入/回复。
5. 原生会话写入领先于 SQL 身份引用时可从其合法 header 恢复。原生回复领先于 SQL 终态时仍展示已保存内容，执行状态保持中断。

Pi 与 SQLite 没有跨存储事务，不承诺后台任务自动续跑或工具操作回滚。首期全量读取原生历史；大文件增量解析、分页与索引重建按实际规模开发。

## 开发重置与备份

当前 schema 不兼容旧版本，不提供迁移。清理前停止后端；删除 state 中的 piko.sqlite、piko.sqlite-wal、piko.sqlite-shm、pi-sessions 和旧 runs，清理已确认退出进程的 backend.lock，再启动即可生成新主会话。

保留 workspace、用户记忆/技能/产物、独立 Pi profile 和凭据。不要在后端运行时删除数据，也不要仅删除数据库后继续复用旧会话目录。

备份先停止 API，再一起复制工作区和整个 state；自定义 PIKO_WORKSPACE 同时保存该目录。恢复使用同批次备份并保留原工作区绝对路径；运行中的普通文件复制不作为一致备份。

## 后续异步任务（方向已定，尚未实现）

任务定义和调度保存在 SQLite；独立 Pi 会话承担执行，详细过程保存在该原生会话中，成果文件进入工作区。完成摘要以 display=true 的 custom_message 写入主会话；不触发额外回复，下一次用户输入使用这份上下文。

主会话繁忙时持久化待投递引用，由主会话串行处理；结果 ID 用于去重，不能靠 Pi 的内存 follow-up 队列保证重启恢复。任务调度、结果卡片、待投递队列和通知均留待后续实现，不提前建立第二套正文存储。

## 验证

自动化覆盖工作区初始化/边界、主会话及 side 关系、输入哈希去重、重试关联、原生消息稳定 ID、压缩后完整 UI 历史、选定分支、可见/隐藏自定义消息、SQL 引用滞后、中断说明去重、原生文件损坏和缺失、SSE 重连与停止。键盘、Markdown、技能与工具测试继续保留。
