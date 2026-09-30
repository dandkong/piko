# Piko 代码结构与后续实现

## 当前目录

```text
apps/mobile/
  App.tsx                       Expo 入口、SafeArea 和 StatusBar
  src/
    theme.ts                    颜色与视觉基础
    components/AppShell.tsx     顶部身份、页面容器、底部 Tab
    api/client.ts               API 地址、HTTP 请求、错误解析
    features/chat/
      ChatScreen.tsx            首页、消息列表、滚动和错误展示
      ChatComposer.tsx          输入框、发送/停止按钮
      styles.ts                 Chat 样式
      useChat.ts                历史加载、发送、流式状态、停止与重试
      api.ts                    Chat HTTP/SSE 通信
      transport.ts              SSE 读取、超时、退避重连和快照恢复
      session.ts                本地会话 ID 存储
server/
  index.ts                      组装依赖、启动 Bun 服务
  config.ts                     环境变量与服务端限制
  app.ts                        HTTP 路由、输入校验、Origin 校验
  http.ts                       JSON 响应与 CORS 响应头
  chat/
    conversations.ts            内存会话复用、容量限制、空闲清理
    run.ts                      内存 Run 状态、独立执行、事件回放和取消
    stream.ts                   输出 SSE、心跳与订阅清理
  runtime/
    types.ts                    Piko 的运行时接口
    pi.ts                       Pi SDK 设置、会话、历史和事件转换
shared/
  chat.ts                       消息、API 与流事件类型、输入限制
  sse.ts                        SSE 编解码
tests/
  chat.test.ts                  流协议解析
  server.test.ts                API、取消与会话生命周期
```

依赖方向为 RN 页面 → Chat Hook/API → HTTP/SSE；服务端路由 → Chat 服务 → 运行时接口 → Pi 适配器。`shared/` 不依赖 React Native、Bun 或 Pi SDK，可同时被两端和测试引用。

Pi SDK 的具体事件、内容块和 profile 设置集中在 `server/runtime/pi.ts`。HTTP 路由和聊天流使用 Piko 自己的类型。测试可注入本地运行时替身，导入 `server/app.ts` 不会监听端口或加载 Pi profile；生产环境始终由 `server/index.ts` 注入 Pi。

首页布局保留 OpenMuse 的 RN 风格。`AppShell` 负责应用通用布局，新页面按功能加入 `src/features/`。菜单、附件和非 Chat Tab 在功能具备之前保持禁用。

## 当前状态约定

- 消息时间使用 Unix 毫秒数，实体 ID 使用 UUID；现有 API 的 `sessionId` 暂时关联一个 Pi 内存会话。
- 当前流事件为 `delta`、`done`、`error`、`cancelled`，传输层附带 `runId` 和递增 `sequence`。Pi 适配器只产生运行时事件，Run 添加传输元数据。
- HTTP 输入校验与 Origin 校验在创建 Run 之前执行。Run 独立于 HTTP 连接，断线和页面卸载只清理观察者；停止按钮调用对应 Run 的取消接口。
- 同一会话在异步创建 Pi session 前就预留 Run，避免并发创建两个回复。同一 `runId`、同一内容的提交返回原 Run，不重复调用模型；已被替换的 Run ID 拒绝再次执行。
- SSE 每 15 秒发送心跳，客户端 45 秒无数据后尝试恢复，使用最多五次退避重连。显示文本每 50 毫秒合并更新，终态立即刷新。
- `useChat` 维护 UI 的临时状态和草稿。持久化业务对象、执行状态与运行结果应由服务端管理。
- 当前仍是纯文本 Chat 原型，会话重启丢失；拆分代码不代表领域模型、数据库或后台任务已经实现。

## 下一步实施顺序

### 1. 核心实体和关系（路线图阶段 0）

先统一 User、Thread、Message、Run、Task、Event、Artifact、Goal、Memory 的 ID、所有权、关联和时间语义。首个可运行增量围绕本地 User → Thread → Message / Run → RunEvent 落地；其余实体随对应阶段接入，避免在 Message 中塞入所有业务状态。

在 `shared/domain/` 定义跨端契约，在 `server/domain/` 管理领域操作；这些目录在首次真正使用时建立。Thread 是用户可见的会话，Run 是一次执行。Pi session 由适配器映射到 Thread，不充当业务记录的唯一来源。迁移现有 `sessionId` 时保留明确的兼容与转换规则。

### 2. 完整的文本 Run 生命周期（阶段 1 的下一增量）

当前已有内存 Run，记录 queued → running → succeeded / failed，以及 cancelling → cancelled；客户端可查看快照、停止指定 Run、断线重连并恢复进度。下一增量把 Run 接入统一领域模型，错误重试记录新旧 Run 关联，再逐步增加持久化与重启恢复。

覆盖打开已有会话、运行中断线后重新进入、停止与完成同时发生、模型错误、重复请求及同一 Thread 的并发请求。持久化与重启恢复按路线图需要逐步接入，在此之前明确进程内状态的边界。

当前的 SSE 编码和 Pi 转换是接入 Run 事件以及后续 AG-UI adapter 的位置；协议适配继续由 Pi 驱动。工具执行与审批在相应能力落地时加入。

### 当前 Chat 传输接口

- `POST /api/chat`：提交 `{ sessionId, runId, message, after? }`，启动或复用 Run，返回 SSE。旧客户端可省略 `runId`，新客户端在提交前生成 UUID。
- `GET /api/sessions/:sessionId`：返回消息与最近 Run 的 `status`、完整输出 `text`、`lastEventId` 和错误。运行中返回已确认历史和当前用户消息，客户端用 Run 快照恢复正在生成的助手消息。
- `GET /api/sessions/:sessionId/runs/:runId/events?after=N`：只返回序号大于 N 的事件。仅保留最近 2,048 条事件，游标过旧或超出当前序号时返回 409；客户端加载快照后从 `lastEventId` 继续订阅。
- `POST /api/sessions/:sessionId/runs/:runId/cancel`：明确终止 Run，多次取消同一已结束 Run 不会再次调用运行时。

会话清理或服务端重启后，Run 订阅返回 404。当前状态、事件和提交去重均限于进程内会话生命周期。活跃 Run 不会被空闲/容量清理，删除会话前必须先停止回复。移动端回到前台会重新查询历史和 Run；这些行为仍需在真机网络与后台切换中验证。

### 3. Activity 和 Artifacts（阶段 2）

在稳定的 Run / RunEvent 基础上增加事件记录、执行轨迹与产物引用，再启用 Activity。Artifact 归属 Thread/Run/Task，记录类型、来源和内容位置，为上传下载以及后续结构化界面提供统一入口。

随后按路线图接入后台 Task、Goal、Memory 和通知。业务服务由受限 Pi 工具调用，每个阶段都补齐用户可见状态及关键状态转换的验证。

## 验证命令

从仓库根目录运行 `bun run typecheck`、`bun run test` 和 `bun run build`。前两个命令覆盖服务端、共享代码和 RN 类型，以及本地协议与服务端测试；`build` 导出 iOS、Android bundle，不生成签名安装包。真机上的键盘、网络和后台切换需要原生运行环境验证。
