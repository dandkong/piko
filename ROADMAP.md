# Piko 开发路线图

这份路线图按**领域模型 → Agent 运行时 → 可见工作 → 异步工作 → 个性化 → 工具与生态**的顺序推进。当前版本是 Pi 聊天原型；未实现的导航项可以为了复用 OpenMuse 布局而禁用显示，但不能打开假的页面或表现为可用。

## 架构约束

- **Pi 是唯一的 Agent / 模型运行时。** Bun 负责托管本地 API、会话和 Pi SDK，不再引入第二套 Agent 框架。
- AG-UI 是 Pi 与聊天 UI 之间的协议适配层，不是另一个 Agent 后端；协议事件由 Pi Session 事件转换而来。
- 业务数据由 Piko 自己的领域模型管理。Pi 通过受限工具调用业务服务，不直接读写数据库或主机资源。
- 按阶段逐步加入持久化，不提前建设通用数据平台；先定领域模型，再在 Goals、Background Tasks 等需要保留状态的阶段引入本地存储和恢复逻辑。
- 有外部影响的操作必须能说明操作对象、记录结果，并在需要时取得用户确认。

## 阶段路线

| 阶段 | 用户看到什么 | 底层真正要实现什么 | 完成标准 | 状态 |
| --- | --- | --- | --- | --- |
| **0. 核心模型** | 暂时没有太多新 UI | User、Thread、Run、Task、Event、Artifact、Goal、Memory 等领域模型及其关联 | 新功能都有各自领域对象，不再把所有状态塞进 Message 表；有统一 ID、时间和状态语义 | 计划中 |
| **1. Chat + Agent** | 主会话，可以让 Pi 干活 | Streaming、工具调用、取消、重试、Run 状态、Pi → AG-UI adapter | 日常聊天和普通 Agent 任务稳定；停止、错误和重新连接行为明确 | 原型部分完成：已有 Pi 文本流、停止；领域 Run 状态、工具调用和 AG-UI adapter 尚未完成 |
| **2. Activity + Artifacts** | 能看到 Agent 在干什么、产生了什么 | Event Log、Run Trace、Artifact Store、文件上传下载 | Agent 工作不再只能从聊天记录理解；Run 可查看进度、事件和产物 | 计划中 |
| **3. Background Tasks** | 关掉网页后 Agent 继续工作 | Queue、Worker、Scheduler、Retry、Idempotency、Resume | 长任务可排队、恢复、取消；重复触发不会重复产生副作用 | 计划中 |
| **4. Goals** | 长期目标、时间线、进度、产物 | Goal State、Timeline、linked tasks、checkpoints、goal context | 一个目标可以持续几周而不依赖一个 chat；目标与任务、产物互相链接 | 计划中 |
| **5. Memory** | Agent 越来越懂你，并可以查看、修改记忆 | Memory extraction、retrieval、provenance、scope、decay | Memory 不只是聊天摘要；每条记忆可追溯、可纠正、可删除 | 计划中 |
| **6. Notifications** | Agent 有事主动找你 | Notification Inbox、Web Push、Significance Filter | 重要进展可到达用户；低价值变化不会持续打扰 | 计划中 |
| **7. Ideas** | Agent 主动建议“可以帮你做什么” | Idea Curator、candidate generation、scoring、dedupe | Goals、Memory 与现有能力能产生可解释、去重的主动建议 | 计划中 |
| **8. Feed** | 个性化研究和信息流 | Feed Brief、Taste、Topic Planner、Research、Writer、feedback | Feed 是私人研究员，不只是 RSS 列表；内容有来源并能反馈偏好 | 计划中 |
| **9. Browser Computer** | Agent 拥有长期浏览器，并可由用户接管 | persistent session、remote viewer、downloads、cookies、takeover | 能稳定操作真实 Web；用户能看见并接管浏览器工作 | 计划中 |
| **10. Secrets + Permissions** | Gmail/API/网站账号能放心交给 Agent | Credential Vault、scopes、approval policy、audit | Secret 不直接暴露给模型；权限可检查、可撤销，敏感操作有审计 | 计划中 |
| **11. Connectors** | 日历、邮件、GitHub 等真正连起来 | OAuth、connector abstraction、webhooks、refresh token | 新连接器可按统一能力接口接入；授权、撤权和失败状态清晰 | 计划中 |
| **12. Agent-native UI** | Dashboard、Tracker、Itinerary 等 | Structured Artifact + renderer / mini-app model | Agent 输出不再只有 Markdown；结构化产物可交互、可复用 | 计划中 |

## 当前原型基线

目前 Piko 具备：

- Vite Web/PWA 聊天界面，以及并行的 Expo / React Native Chat 原型（可用 React Native Web 预览）。两端共享消息与 SSE 事件契约。
- Bun API 在服务端进程内通过 Pi SDK 建立 `AgentSession`，并以 SSE 流式回传文本；两个前端都连接同一 API。
- Pi coding tools 默认全部关闭；当前只做纯聊天。
- 会话使用内存存储，服务端重启后上下文会清空；还没有领域数据库、Run/Event/Artifact 模型。
- Web 与 RN 的菜单、通知和非 Chat 导航目前只是布局占位，不代表对应功能已经实现。

因此当前是**Chat 原型**，不能算阶段 0 或阶段 1 完成。下一步先定核心实体及其关联，再按阶段补齐运行状态、Activity 与产物。

## UI 页面演进

页面随阶段逐步启用。当前保留的 OpenMuse 风格导航图标是禁用占位；功能完成并通过验收后再开放：

| 页面 / 导航入口 | 首次出现阶段 | 主要内容 |
| --- | --- | --- |
| Chat | 1 | 主会话、Pi 输出流、Run 状态 |
| Activity | 2 | Run Trace、事件时间线、Artifacts |
| Tasks / Schedule | 3 | 后台任务队列、执行计划、重试与恢复 |
| Goals | 4 | 目标、里程碑、关联任务、时间线 |
| Memory | 5 | 可搜索、编辑和删除的用户记忆 |
| Notifications | 6 | Inbox、重要性和已读状态 |
| Ideas | 7 | 建议、证据、接受/忽略 |
| Feed | 8 | 主题、研究简报、来源与反馈 |
| Browser | 9 | session、截图、下载与接管 |
| Connections / Permissions | 10–11 | 凭据、scope、连接器状态和审批 |
| Artifact mini-apps | 12 | Tracker、Dashboard、Itinerary 等结构化 UI |

移动端一级导航优先保持简短，非核心页面可放进 More；Chat 始终是首页。

## 阶段验收约定

每个阶段完成前都要具备：

1. **领域契约：**输入、输出、状态流转和所有权有清晰类型与校验。
2. **Pi 工具边界：**工具只暴露当前阶段所需能力，不直接给予 Pi 通用主机权限。
3. **可恢复性：**明确进程重启、重复请求、取消、超时和部分失败的结果。
4. **用户可见性：**前端覆盖空状态、运行中、失败、完成和重新打开等主要状态。
5. **验证：**关键状态转换有自动化测试，并能按文档在本地复现。

阶段 10 的凭据和权限设计应先于阶段 11 的真实连接器；阶段 9 的 Browser 在此之前只允许公开网页读取和人工接管，不使用私人账号凭据。
