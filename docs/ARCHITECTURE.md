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
      session.ts                本地会话 ID 存储
server/
  index.ts                      组装依赖、启动 Bun 服务
  config.ts                     环境变量与服务端限制
  app.ts                        HTTP 路由、输入校验、Origin 校验
  http.ts                       JSON 响应与 CORS 响应头
  chat/
    conversations.ts            内存会话复用、容量限制、空闲清理
    stream.ts                   输出 SSE、取消与订阅清理
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
- 当前流事件为 `delta`、`done`、`error`。后续扩展协议时，同时更新共享类型、Pi 事件转换和客户端消费者。
- HTTP 输入校验与 Origin 校验在创建流之前执行；流取消负责停止自己启动的回复并清理订阅。
- `useChat` 维护 UI 的临时状态和草稿。持久化业务对象、执行状态与运行结果应由服务端管理。
- 当前仍是纯文本 Chat 原型，会话重启丢失；拆分代码不代表领域模型、数据库或后台任务已经实现。

## 下一步实施顺序

### 1. 核心实体和关系（路线图阶段 0）

先统一 User、Thread、Message、Run、Task、Event、Artifact、Goal、Memory 的 ID、所有权、关联和时间语义。首个可运行增量围绕本地 User → Thread → Message / Run → RunEvent 落地；其余实体随对应阶段接入，避免在 Message 中塞入所有业务状态。

在 `shared/domain/` 定义跨端契约，在 `server/domain/` 管理领域操作；这些目录在首次真正使用时建立。Thread 是用户可见的会话，Run 是一次执行。Pi session 由适配器映射到 Thread，不充当业务记录的唯一来源。迁移现有 `sessionId` 时保留明确的兼容与转换规则。

### 2. 完整的文本 Run 生命周期（阶段 1 的下一增量）

由服务端创建 Run，记录 queued → running → succeeded / failed / cancelled 的合法转换。为客户端提供当前状态、结果和错误；停止按 Run 定位，重试创建关联的新 Run，请求去重避免重复提交。

覆盖打开已有会话、运行中断线后重新进入、停止与完成同时发生、模型错误、重复请求及同一 Thread 的并发请求。持久化与重启恢复按路线图需要逐步接入，在此之前明确进程内状态的边界。

当前的 SSE 编码和 Pi 转换是接入 Run 事件以及后续 AG-UI adapter 的位置；协议适配继续由 Pi 驱动。工具执行与审批在相应能力落地时加入。

### 3. Activity 和 Artifacts（阶段 2）

在稳定的 Run / RunEvent 基础上增加事件记录、执行轨迹与产物引用，再启用 Activity。Artifact 归属 Thread/Run/Task，记录类型、来源和内容位置，为上传下载以及后续结构化界面提供统一入口。

随后按路线图接入后台 Task、Goal、Memory 和通知。业务服务由受限 Pi 工具调用，每个阶段都补齐用户可见状态及关键状态转换的验证。

## 验证命令

从仓库根目录运行 `bun run typecheck`、`bun run test` 和 `bun run build`。前两个命令覆盖服务端、共享代码和 RN 类型，以及本地协议与服务端测试；`build` 导出 iOS、Android bundle，不生成签名安装包。真机上的键盘、网络和后台切换需要原生运行环境验证。
