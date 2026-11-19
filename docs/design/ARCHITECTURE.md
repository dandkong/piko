# Piko 架构约定

本文定义跨功能依赖方向、状态所有权和安全边界。具体行为以[功能文档](../README.md#功能说明)为准，配置、存储与运行细节见[运维参考](../README.md#配置与运维)。

## 系统结构

```text
Expo / React Native → HTTP + SSE ──┐
                                 ├── Bun 会话服务 → 运行时接口 → pi-durable → pi-ai
Telegram 私聊 → Bot API 适配器 ────┘
```

- 客户端按**页面 → Hook/API → HTTP/SSE**分层，功能放在 `apps/mobile/src/features/`，共用界面组件与主题放在 `apps/mobile/src/components/` 和 `theme.ts`。
- 服务端按**路由/通道 → 业务服务 → 运行时接口 → Pi 适配器**分层；SDK 类型和事件留在 `server/runtime/`，Telegram SDK 留在通道目录，工具业务与 SDK 注册分离。`AppRuntime` 是唯一运行时的组合接口，路由和通道只依赖所需的会话、任务、帖子或设置能力。
- `shared/` 只放跨端普通类型和纯逻辑，不依赖 React Native、Bun 或 Pi SDK。
- 一个后端进程拥有一个 Harness、主会话和工作区；旁聊、后台工作及任务执行使用同一 Harness 的独立会话。相关所有权和资源策略见[主会话](../features/main-chat.md)、[旁聊](../features/side-chats.md)与[Agent 构建](../features/agent-composition.md)。

## 状态与执行

- **Durable 原生 SQLite、Harness 和原始 entries 是事实来源**。消息历史从原始 entries 投影；不另建消息正文、Run 状态或永久流事件副本。配置、附件和工作区文件分别保存在数据库之外。
- 用户输入、停止、维护、删除和内部报告统一经过 `ConversationControl` 接纳线；`ConversationStore` 负责输出合并和观察，关闭观察不停止执行。runtime 唯一拥有控制器和 Harness 生命周期。
- 客户端经 HTTP 提交操作，经 SSE 接收快照和实时变化。断线恢复重新观察，不重发输入；SSE 不保存永久事件日志。传输与活动投影详见[会话事件](../features/conversation-events.md)。
- 使用 Durable 原生提交身份去重、停止和恢复；重启时不重放不确定的模型或工具执行，也不回滚外部副作用。RN 请求身份使用 UUID，Durable 分配的实体 ID 跨端作为不透明字符串传递，时间使用 Unix 毫秒。
- 会话及业务数据按归属维护和删除；删除不等于全介质擦除，也不删除无关工作区文件、附件或备份。详见[SQLite 存储](../operations/storage.md)。

## 工作区、配置与资源

- 工作区与源码分离，默认位于 `~/.piko/workspace`；配置、会话状态和附件默认位于 `~/.piko`。`PIKO_HOME` 和 `PIKO_WORKSPACE` 可指定位置。初始化只补缺失内容，不覆盖用户文件。
- 工作区保存用户指导、记忆、技能和工作材料；内建资源随应用发布。资源范围显式指定，不自动继承个人 Pi CLI、祖先指导或用户代码扩展。详见[工作区](../features/workspace.md)。
- `piko.json` 管应用和 Agent 行为，`mcp.json` 管 MCP Server，`models.json` 与 `auth.json` 管模型配置和凭据；部署参数、通道和工具凭据来自后端环境或私有 `.env`。具体字段与生效时机见[应用配置](../operations/configuration.md)。
- Durable Extension 由 Piko 源码注册；MCP Server 通过 Piko 的客户端适配器接入，不作为工作区代码插件加载。工具权限和资源选择由运行时执行，不靠提示词实现。参见[MCP 工具](../features/mcp.md)。

## 安全边界

工作区 cwd 不是沙箱。文件、命令及 MCP 工具使用后端进程或外部服务授予的权限，可能读取敏感信息或产生外部副作用。当前 API 无内置认证或多用户隔离；默认监听本机，远程访问需要保护 Web、API 和 SSE 并阻止绕过代理直连。详见[部署说明](../operations/deployment.md)。
