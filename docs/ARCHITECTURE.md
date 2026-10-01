# Piko 架构约定

本文记录当前实现与后续边界。体验见 [PRODUCT](PRODUCT.md)，进度见 [路线图](../ROADMAP.md)，存储和恢复细节见 [工作区与主会话模型](features/workspace-and-main-chat.md)。

## 当前结构

~~~text
Expo / React Native (Web、iOS、Android)
                 │ HTTP + SSE
            Bun Chat 服务
                 │ 运行时接口
            Pi SDK / ModelRuntime
~~~

| 位置 | 职责 |
| --- | --- |
| apps/mobile/src/features/chat/ | 页面、输入、临时状态、主会话发现、HTTP/SSE |
| apps/mobile/src/components/、theme.ts | 通用布局、头像、导航和视觉 |
| server/app.ts、http.ts | 路由、输入校验、响应和 CORS；导入不监听端口 |
| server/index.ts、config.ts | 配置、初始化、单进程锁和依赖组装 |
| server/chat/ | Run 生命周期、去重、取消、内存文本快照与事件重放 |
| server/domain/ | 工作区初始化、SQLite 身份/执行元数据、重启标记中断 |
| server/runtime/ | Pi 适配、资源范围、原生会话校验与完整历史投影 |
| server/resources/ | 核心指导、内建技能和用户文件模板 |
| shared/ | 跨端领域、消息与 SSE 契约，不依赖 React Native、Bun 或 Pi |
| tests/ | 键盘、协议、API、并发、原生持久化、恢复和资源范围验证 |

依赖方向：页面 → Hook/API → HTTP/SSE；路由 → 业务服务 → 运行时接口 → Pi 适配器。测试使用临时状态与运行时替身，不加载个人模型凭据。

Pi 是唯一 Agent / 模型运行时，也是唯一会话内容存储：模型消息、工具结果、自定义消息、压缩与分支都使用其原生 JSONL。Piko 管理产品、工作区/会话关系、执行生命周期、传输和后续调度，不能再复制一套聊天正文或永久流事件。

## 工作区与状态

默认位于后端机器的 ~/.piko，独立于源码仓库。PIKO_HOME 修改根目录，PIKO_WORKSPACE 单独指定工作区，均要求绝对路径。

~~~text
~/.piko/
├── state/
│   ├── backend.lock                 # 单后端写进程
│   ├── piko.sqlite                  # 身份、执行元数据、原生会话引用
│   └── pi-sessions/<thread-id>.jsonl # 唯一会话内容来源
└── workspace/
    ├── AGENTS.md                    # 用户工作指导
    ├── SOUL.md                      # 人格与语气
    ├── USER.md                      # 用户资料与长期偏好
    ├── MEMORY.md                    # 精简长期记忆
    ├── .agents/skills/<name>/SKILL.md
    ├── memory/
    ├── projects/
    └── artifacts/
~~~

初始化只补缺失模板，保留用户内容，拒绝类型冲突和越界链接目录。状态必须位于工作区之外。模型与凭据沿用独立 Pi profile（通常 ~/.pi/agent）；Piko 的资源和运行设置单独管理。当前 schema 为 2，开发期不兼容旧库、不提供迁移。

## 资源与工具

复用锁定版本 Pi SDK 的 DefaultResourceLoader、SettingsManager、SessionManager 和技能格式，以安装源码为准。

- 显式加载工作区 .agents/skills，再加载 server/resources/skills；同名用户技能优先并输出诊断。
- 关闭默认全局/祖先技能、扩展、提示模板、主题和上下文发现，不继承个人 CLI 或源码指导。
- 工作区 AGENTS.md 最多加载 8,000 字节；SOUL.md、USER.md、MEMORY.md 各 4,000 字节，注明来源，超量截断。
- 核心指导来自 server/resources/prompts/core.md；每轮发送前重新加载指导和技能索引。
- read、write、edit、bash 四个内建工具显式启用，刷新后仍保持激活；可按需读技能正文、创建技能和脚本、维护记忆文件。自动记忆提取/检索未实现。
- 工具使用后端本机权限，cwd 为工作区，不提供文件沙箱或单独审批界面。未来访问边界必须由运行时实现。
- Pi 设置启用原生上下文压缩与有限重试。工具参数与结果保存在原生日志，当前 SSE/UI 展示文本和执行终态，工具进度与产物界面尚未实现。

## 领域与展示投影

| 对象 | 当前职责 |
| --- | --- |
| Workspace | SQLite 保存稳定 UUID、规范化路径和创建时间 |
| Thread | 工作区内 main / side；唯一 main，side 预留 parentThreadId；保存原生会话身份引用 |
| Message | Pi 完整选定分支的临时投影，ID 为 pi-<原生 entry ID>；没有消息表或独立日志 |
| Run | SQLite 保存顺序、状态、输入 SHA-256、时间、重试来源、错误和最近状态游标；不保存正文 |
| StreamEvent | SSE 增量/终态；最近 2,048 条只在当前进程内存中重放 |
| Task / Artifact（后续） | 任务定义/调度/投递元数据；成果文件保存在工作区 |

实体 ID 使用 UUID，时间为 Unix 毫秒数。Pi entry ID 直接作为展示身份，不使用消息下标。原生 state-only 的 piko-run 条目关联一次执行与后续消息，只包含 runId，不复制输入或输出。

历史投影读取 SessionManager.getBranch()，不能使用 session.messages 或压缩感知的 buildSessionProjection() 代替完整 UI 历史。普通用户/助手文本形成气泡；display=true 的原生 custom_message 也可展示，隐藏指导、压缩和内部状态不显示。工具记录仍在原生日志中，当前不渲染。模型上下文编辑不改写已经展示的原始历史。

执行中，已保存的本轮助手片段由内存聚合快照统一展示，避免与 SSE 文本重复；尚未出现原生用户条目时使用临时提交占位。终态重新读取原生历史，不保存这层临时投影。

## API 与执行

- GET /api/main：默认 Workspace、主 Thread 和 sessionId（等于 thread.id）。
- POST /api/chat：提交或复用 Run，返回 SSE；参数 sessionId、runId、message、after?、retryOfRunId?。
- GET /api/sessions/:id：完整原生历史投影和最近 Run 快照。
- GET /api/sessions/:id/runs/:runId/events?after=N：内存重放；游标过期、越界或重启后返回 409，客户端加载快照。
- POST /api/sessions/:id/runs/:runId/cancel：独立取消；重复取消不重复调用 Pi。
- 主会话删除不可用；不接受任意客户端 UUID 创建新会话。

同 Thread 仅一个活跃 Run，由 SQLite 唯一约束保证。先持久化输入哈希与身份，再调用 Pi；输入正文由 Pi 保存一次。同 ID 同哈希及重试来源复用，不同内容拒绝，重启后仍去重。用户重试必须引用失败 Run、使用相同输入，并创建新 UUID。

状态 queued → running → succeeded / failed；停止经过 cancelling → cancelled。完成前 fsync 原生会话，再提交 SQL 状态，然后发布终态。流式增量不落盘，按最多 50 毫秒合并；SSE 15 秒心跳，客户端 45 秒无数据恢复并有限退避。断线只解除观察，不取消执行；回前台加载快照。

## 原生恢复与限制

启动校验主会话原生文件；缺失已引用文件、身份不一致或内部损坏拒绝继续。末尾半条 JSON 归档后截掉残片。SQLite 仅保存原生 file/sessionId，不保存 committed leaf，也不回退原生历史。

遗留活跃 Run 标记 failed + interrupted，不自动调用模型。保留 Pi 已保存的消息，未保存的流式片段可丢失；若用户消息尚未写入 Pi，则没有可恢复的输入正文，需重新发送。重新创建 Agent 时在原生上下文追加一次隐藏的中断说明，避免自动延续不确定执行；不复制原输入或回复。

Pi 文件与 SQLite 不构成跨存储事务。原生消息保存后、SQL 终态提交前崩溃，消息仍可见，但执行标记中断。旧 SSE 事件不伪造重放，客户端从快照恢复。当前全量读取历史；分页与增量索引按规模再引入。

备份前停止后端，复制工作区与完整 state（含仍存在的 WAL/SHM）；模型凭据属于独立 Pi profile。重置开发数据仅清理数据库与会话日志，不删除工作区、用户技能或凭据。

## 异步任务方向（尚未实现）

定时任务使用独立 Pi 会话执行，详细过程留在任务会话；完成摘要通过原生 custom_message 进入主会话，以 triggerTurn=false 保存供 UI 和下一次用户提问使用。主会话忙碌时等待安全写入边界。

未来 SQLite 只增加任务定义、调度、执行与待投递状态；结果引用原生条目/工作区文件，不另建正文库。需要持久化投递并去重，不能依赖 Pi 的内存队列。调度器、任务结果卡片、后台通知和投递接口均未实现。
