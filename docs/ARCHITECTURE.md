# Piko 架构约定

本文区分当前实现与目标设计。产品体验见 [PRODUCT](PRODUCT.md)，开发顺序见 [路线图](../ROADMAP.md)，下一阶段细节见 [工作区与主会话模型](features/workspace-and-main-chat.md)。

## 当前实现

```text
Expo / React Native (Web、iOS、Android)
                 │ HTTP + SSE
            Bun Chat 服务
                 │ 运行时接口
            Pi SDK / ModelRuntime
```

| 位置 | 职责 |
| --- | --- |
| `apps/mobile/App.tsx` | 应用初始化、SafeArea、StatusBar |
| `apps/mobile/src/components/`、`theme.ts` | 页面容器、头像与导航、通用视觉 |
| `apps/mobile/src/features/chat/` | 页面、输入框、临时 UI 状态、API、SSE transport、本地 sessionId |
| `apps/mobile/src/api/client.ts` | API 地址、HTTP 请求和错误解析 |
| `server/index.ts`、`config.ts` | 依赖组装、监听和配置 |
| `server/app.ts`、`http.ts` | 路由、校验、响应和 CORS |
| `server/chat/` | 内存会话、Run、事件回放、取消和流输出 |
| `server/runtime/` | Piko 运行时接口、Pi 事件和 profile 适配 |
| `shared/` | 跨端消息契约、校验和 SSE 编解码 |
| `tests/` | 键盘、流协议、API 和执行生命周期验证 |

依赖方向：页面 → Hook/API → HTTP/SSE；路由 → 业务服务 → 运行时接口 → Pi 适配器。`shared/` 不依赖 React Native、Bun 或 Pi SDK。测试注入运行时替身；导入路由不监听端口、不加载个人 Pi profile。

当前客户端保存 UUID sessionId，服务端以它关联 Pi 内存会话。消息与上下文、最近 Run 和回放事件均在内存，服务端重启或会话淘汰后丢失。Pi 技能、扩展、上下文文件和文件/命令工具目前关闭。工作目录仍是源码启动目录。

### 当前传输与执行

- `POST /api/chat`：提交 `{ sessionId, runId, message, after? }`，启动或复用 Run 并返回 SSE；旧客户端可省略 runId。
- `GET /api/sessions/:sessionId`：消息和最近 Run 快照，包括输出、状态、游标和错误。
- `GET /api/sessions/:sessionId/runs/:runId/events?after=N`：续订序号大于 N 的事件；最多保留 2,048 条，游标过期或越界返回 409，客户端读取快照后继续。
- `POST /api/sessions/:sessionId/runs/:runId/cancel`：取消指定 Run，终态上的重复取消不再次调用运行时。
- Run 独立于 HTTP 观察者；断线只结束订阅，执行继续。创建模型会话前预留 Run，同会话不能并发回复。同 ID 同内容提交复用，不同内容拒绝；去重目前仅在进程生命周期内有效。
- 状态为 queued → running → succeeded / failed，取消经过 cancelling → cancelled；停止与完成的竞争必须只产生一个终态。
- SSE 每 15 秒心跳；客户端 45 秒无数据后恢复，最多五次退避重连；文本每 50 毫秒合并刷新，终态立即更新。
- 当前会话消失后订阅返回 404，不自动重新提交已接受的回复。移动端回前台读取历史和快照，真机网络与后台行为仍需持续验证。

## 已确定的目标边界（尚未实现）

Pi 是唯一 Agent / 模型运行时，负责模型、Agent 循环、技能资源机制、模型上下文与压缩。Piko 负责个人助理产品、业务对象、持久化、工作区、工具访问边界和客户端。后续 AG-UI 只作为 Pi 事件到 UI 的适配层，接入时不得破坏现有 Run 与恢复语义。

模型生成内容是建议或结果；工具成功回执和业务状态确认才代表操作完成。权限、文件访问和凭据边界由运行时实现，不能依赖提示词约束。

### 工作区与应用资源

工作区属于助理，主会话和未来 side chat 关联工作区。它在运行后端的机器上，独立于源码仓库，默认路径建议如下；实际配置将在实施时确定。

```text
~/.piko/
├── config.json                  # Piko 配置（目标）
├── state/
│   ├── piko.sqlite              # 业务历史与执行状态（目标）
│   └── pi-sessions/             # Pi 上下文文件（位置待 SDK 核对）
└── workspace/
    ├── AGENTS.md                # 用户工作指导
    ├── SOUL.md                  # 人格与语气
    ├── USER.md                  # 用户资料与长期偏好
    ├── MEMORY.md                # 精简长期记忆
    ├── .agents/skills/<name>/
    │   ├── SKILL.md
    │   ├── scripts/
    │   └── references/
    ├── memory/                  # 按需检索的详细记忆
    ├── projects/                # 专题工作文件
    └── artifacts/               # 交付物
```

聊天数据库和凭据位于助手可写工作区之外。初期继续使用现有 Pi profile 的模型/凭据，资源范围独立控制；后续迁移独立 profile 时明确授权和导入规则。记忆文件作为正文来源，检索库仅保存索引，避免两个可修改的正文来源。

内建资源建议置于应用的 `server/resources/prompts/`、`skills/`、`templates/`，首次实际使用时建立：核心指导和技能随应用升级，模板仅初始化缺失的用户文件。用户定制内建技能使用工作区副本，记录来源版本，不修改安装包原件。

### Pi 资源接入

复用当前 Pi SDK 的 DefaultResourceLoader、SettingsManager、SessionManager 和 Agent Skills 格式；不重写一套技能解析和模型上下文管理。

- 用户技能采用 `.agents/skills/<name>/SKILL.md`，说明、脚本、参考文件使用技能目录内相对路径。
- 显式加载工作区资源和内建资源，控制默认发现。Pi 能发现全局与祖先目录资源，Piko 不自动继承个人 CLI 技能、扩展或源码指导。
- 技能索引先提供名称、描述、路径；正文按需读取。技能加载不等于脚本执行，必须有对应受限工具才具备实际能力。
- Pi 同名技能采用先发现者保留；Piko 显式实现用户技能优先、内建回退及冲突诊断，不假定默认顺序满足需求。
- AGENTS.md 可通过 Pi 上下文接口加载；SOUL.md / USER.md / MEMORY.md 的含义和加载由 Piko 管理，不能假定 Pi 自动识别。
- Piko 组装内建指导、工作区指导、受控记忆摘要和运行上下文；各类文本都有预算与来源。当前请求、运行状态与技能变更应在明确边界刷新，不将全工作区塞进提示。
- Pi 设置用于压缩、重试等运行参数；Piko 配置用于工作区路径、API 和业务策略，避免同一个选项有两份互相覆盖的配置。

以上依据安装的 Pi SDK 0.99.1 及 [官方技能文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)、[SDK 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)。实现时以锁定版本源码和示例为准。

### 核心模型

| 对象 | 关系与职责 |
| --- | --- |
| Workspace | 稳定 ID、工作区路径、初始化信息；与 Thread 关联 |
| Thread | 工作区内的一条对话，类型 main / side；每个 Workspace 唯一 main，side 关系预留 |
| Message | Thread 内可见记录，稳定 ID、角色、内容、顺序和时间；输出关联 Run |
| Run | Thread 中一次执行，关联输入/输出、状态、错误、重试来源及 Pi 上下文 |
| RunEvent | Run 内有序事件，支持进度、恢复游标和终态 |
| Artifact（后续） | 归属工作区及产生它的 Thread / Run / Task，引用实际文件或结构化内容 |

实体 ID 使用 UUID，时间使用 Unix 毫秒数。首期本地单助理、单后端，当前不实现登录、多用户或 side chat 操作。Task、Goal、Memory 等在首次使用时细化，不预建全部表。跨端领域契约与服务层分别放在 `shared/domain/`、`server/domain/`，存储实现不泄漏到客户端。

### 历史、上下文与恢复

Piko SQLite 管理用户可见历史和业务状态，Pi 持久会话管理模型上下文和压缩记录。Thread 与 Pi session 有明确映射；压缩不删除聊天历史。不能用模型消息下标充当永久业务 ID。

初期持久化优先保证重开和重启可继续交流。运行中服务重启应记录明确中断、保留已保存输出，不自动重放；可靠后台任务恢复另行实现。跨 SQLite 与 Pi 文件的写入一致性、异常修复和 API 迁移，在 [功能方案](features/workspace-and-main-chat.md) 中展开。

## 文档维护

长期边界保留在本文，体验放 PRODUCT，进度放 ROADMAP，具体接口、迁移、失败行为与验收放对应功能方案。已实现内容随着代码更新；待定问题保持明确，不将目标目录、配置或接口写成现状。
