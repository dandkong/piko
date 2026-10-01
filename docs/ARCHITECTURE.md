# Piko 架构约定

本文记录当前实现与后续边界。体验见 [PRODUCT](PRODUCT.md)，进度见 [路线图](../ROADMAP.md)，存储和恢复细节见 [工作区与主会话模型](features/workspace-and-main-chat.md)。

## 当前结构

```text
Expo / React Native (Web、iOS、Android)
                 │ HTTP + SSE
            Bun Chat 服务
                 │ 运行时接口
            Pi SDK / ModelRuntime
```

| 位置 | 职责 |
| --- | --- |
| `apps/mobile/src/features/chat/` | 页面、输入、临时状态、主会话发现、HTTP/SSE |
| `apps/mobile/src/components/`、`theme.ts` | 通用布局、头像、导航和视觉 |
| `server/app.ts`、`http.ts` | 路由、输入校验、响应和 CORS；导入不监听端口 |
| `server/index.ts`、`config.ts` | 配置、初始化、单进程锁和依赖组装 |
| `server/chat/` | Run 生命周期、提交去重、取消、流观察与回放 |
| `server/domain/` | 工作区初始化、SQLite 索引、Piko JSONL 和启动恢复 |
| `server/runtime/` | Piko 运行时接口、Pi 适配、资源范围和原生会话检查点 |
| `server/resources/` | 随应用发布的核心指导、内建技能和用户文件模板 |
| `shared/` | 跨端领域、消息与 SSE 契约，不依赖 React Native、Bun 或 Pi |
| `tests/` | 键盘、协议、API、并发、持久化、恢复和资源范围验证 |

依赖方向：页面 → Hook/API → HTTP/SSE；路由 → 业务服务 → 运行时接口 → Pi 适配器。测试注入运行时替身，不加载个人模型凭据。

Pi 是唯一 Agent / 模型运行时，负责模型、Agent 循环、技能解析、模型上下文与压缩。Piko 负责产品、领域对象、持久化、工作区与访问边界。后续 AG-UI 可作为事件适配层，不替代 Run 与恢复语义。

## 工作区与状态

默认位于后端机器的 `~/.piko`，独立于源码仓库。`PIKO_HOME` 修改 Piko 根目录，`PIKO_WORKSPACE` 单独指定工作区，均要求绝对路径。

```text
~/.piko/
├── state/
│   ├── backend.lock             # 一个状态目录只有一个后端写进程
│   ├── piko.sqlite              # 身份、关系、状态、游标、文件与上下文检查点索引
│   ├── runs/<run-id>.jsonl      # Piko 输入、输出增量、事件与终态
│   └── pi-sessions/<thread-id>.jsonl # Pi 原生上下文、摘要与分支
└── workspace/
    ├── AGENTS.md                # 用户工作指导
    ├── SOUL.md                  # 人格与语气
    ├── USER.md                  # 用户资料与长期偏好
    ├── MEMORY.md                # 精简长期记忆
    ├── .agents/skills/<name>/SKILL.md
    ├── memory/                  # 后续详细记忆
    ├── projects/                # 专题文件
    └── artifacts/               # 交付物
```

初始化只补缺失模板，保留用户内容，拒绝类型冲突和逃出工作区的链接目录。状态必须位于工作区之外。模型和凭据暂沿用现有 Pi profile（通常 `~/.pi/agent`）；Piko 的资源范围和运行设置单独管理。

内建指导和技能随应用更新；用户定制内建技能可在工作区创建同名副本。当前读取、写入与执行复用 Pi 内建工具，以后端进程的本机权限运行。cwd 是默认目录，不提供文件隔离；后续访问边界由运行时实现。

## 资源加载

复用锁定版本 Pi SDK 的 DefaultResourceLoader、SettingsManager、SessionManager 和技能格式，以安装源码为准。

- 显式加载工作区 `.agents/skills`，再加载 `server/resources/skills`，同名用户技能优先并输出冲突诊断。
- 默认全局/祖先技能、扩展、提示模板、主题、上下文发现关闭，不继承个人 CLI 或源码指导。
- 工作区 AGENTS.md 最多加载 8,000 字节；SOUL.md、USER.md、MEMORY.md 各 4,000 字节，注明来源，超量截断。
- 核心指导来自 `server/resources/prompts/core.md`；每轮发送前重新加载工作区指导和技能索引。
- read、write、edit、bash 四个内建工具显式启用，资源刷新后仍保持激活。
- 模型可通过 read 按需读取技能正文，并通过文件工具创建技能，通过命令工具运行脚本；新技能在下一轮进入索引。自动记忆提取/检索尚未实现，模型可以按用户要求直接维护记忆文件。
- 工具调用、参数和结果由 Pi 原生会话记录保存；当前 SSE/UI 只提供文本流与 Run 终态，工具进度和 Activity 展示后续接入。
- Pi 内存设置启用原生上下文压缩与有限重试，不自动继承工作区或个人 CLI 的运行设置。

## 领域与存储

| 对象 | 关系与存储 |
| --- | --- |
| Workspace | 稳定 UUID、规范化路径和初始化时间；SQLite 索引 |
| Thread | 工作区内 main / side 对话；每个工作区唯一 main，side 预留 parentThreadId |
| Message | 从 Piko Run 日志投影为可见记录；稳定 `user-<run-id>` / `assistant-<run-id>` ID |
| Run | 一次执行；SQLite 保存顺序、状态、游标和文件名，JSONL 保存内容及重试来源 |
| RunEvent | Run 内有序事件，完整保留于 JSONL，最近 2,048 条用于快速续订 |
| Artifact（后续） | 工作区文件或结构化产物，关联 Thread / Run / Task |

实体 ID 使用 UUID，时间为 Unix 毫秒数。Message 是稳定投影，不根据 Pi 消息下标生成 ID。JSONL 是正文来源，SQLite 不重复保存消息/事件正文。模型上下文压缩不影响可见聊天历史。

首期单助理、单写进程、多客户端。客户端通过服务端发现唯一主 Thread。side chat 只预留类型与关系，没有创建接口或切换界面；Task、Goal、Memory 在实际开发时细化。

## API 与执行

- `GET /api/main`：默认 Workspace、主 Thread 及兼容字段 sessionId（等于 thread.id）。
- `POST /api/chat`：`{ sessionId, runId, message, after?, retryOfRunId? }`，提交或复用 Run，返回 SSE。
- `GET /api/sessions/:id`：完整可见消息和最近 Run 快照。
- `GET /api/sessions/:id/runs/:runId/events?after=N`：恢复指定 Run，游标过期或越界返回 409，客户端先加载快照。
- `POST /api/sessions/:id/runs/:runId/cancel`：独立取消，重复取消不再次调用模型。
- 主会话删除暂返回 409；旧客户端 sessionId 返回 409，需重新加载主会话。

Run 独立于观察者，断线不取消。预留并持久化输入后才启动模型；同 Thread 仅一个活跃 Run，由 SQLite 唯一约束保证。同 ID 同内容与重试来源复用，修改内容拒绝；重启后和后续轮次仍可去重。

状态为 queued → running → succeeded / failed，取消经过 cancelling → cancelled。服务重启把遗留活跃 Run 变为 `failed + errorCode: interrupted`，保留已保存输出，不自动重跑；用户重试产生新 UUID，关联旧 Run。

持久输出最多按 50 毫秒合并增量，终态强制保存，保存后才向观察者发布。SSE 15 秒心跳，客户端 45 秒无数据恢复并有限退避，UI 文本按 50 毫秒合并。回前台加载快照并恢复观察。

## 两类 JSONL 的一致性

Piko 日志先写并 fsync，再更新 SQLite，最后发布事件。启动时从日志修复落后的索引，收养已写入但未入库的提交文件；内容缺失、内部损坏或索引领先则报告问题。仅被截断的最后一条 JSON 先归档再修复。

Pi 原生日志保留模型上下文与压缩。SQLite 保存已确认的 session ID 和 leaf ID，不保存原生正文；终态日志也带小型检查点用于索引修复。恢复时回到已提交分支，保留未确认尾部；中断 Run 以历史说明加入新上下文，不当成新请求执行。

跨两类文件和 SQLite 无单一事务。写入或检查点异常不能静默清空上下文。备份需要一起保存工作区与完整状态目录，详细操作及限制见功能方案。可靠后台任务恢复、历史分页/索引重建和单独 profile 迁移属于后续功能。
