# 中期结构重构与回归清单

状态：已实现（2026-10-22）。保留原生存储身份与已确认交互，不引入兼容入口、Run 表、可靠 outbox 或通用框架；后续移除无客户端消费者的 HTTP 管理入口，当前接口以架构文档为准。架构见 [ARCHITECTURE](../ARCHITECTURE.md)。

## 责任与依赖

- `runtime/pi.ts` 组装服务、缓存会话控制器并唯一拥有生命周期；`bootstrap.ts` 在 resume 前完成 root/cwd 校验、取消不确定执行、恢复报告阶段和策略刷新。
- `conversation-session.ts` 是单会话 facade；`conversation-control.ts` 是唯一输入/停止/维护/归档/内部报告接纳线；`conversation-view.ts` 负责历史、分页、快照、工具和流式投影。固定原生文档在 `conversation-docs.ts`。
- 旁聊业务在 `side-chat-service.ts`，原生元数据和身份查询在 `side-chats.ts`。模块不回调 composition root 实现业务规则；只接受所需的控制器、当前 root Agent 与共用执行依赖。
- `subagents/runtime.ts` 管 Anchor/Reporter 和取消；`queries.ts` 统一 owner 校验和原生事实读取，事务内按 child 分组；`recovery.ts` 管重启策略；`tools.ts` 只做 schema、调用和输出编码。
- `tasks/service.ts` 管定义/游标/幂等/调度，`documents.ts` 管固定原生身份，`queries.ts` 按需投影，`tools.ts` 为模型入口。任务服务依赖共用执行和事实查询，不依赖普通委派工具。
- `model-config.ts` 加载模型目录、凭据与角色配置，`model-provider.ts` 处理供应商模型、headers、请求选项与 stream 适配。
- `workspace.ts`、`task-files.ts` 管文件 I/O；`domain/tasks.ts` 只管定义校验和日历计算。
- HTTP 按 chat/side-chats/tasks/attachments 分 handler；app 只分发、转换错误、处理 CORS 和 Web fallback。公共 body reader 即使没有 Content-Length，也在读流时限制大小并取消超限流。

## 接纳与关闭

内部报告不得在 canReport 检查之后自行调用原生 submit。它先进入父 ConversationControl，再进入后台取消接纳线，在最终提交前复核 epoch；归档使用相同顺序，不能反向持锁。

归档预留覆盖停止前台、撤回内部报告、停止子工作和写归档标记全过程。报告排在归档之后时，因 archived owner 或失效 epoch 被消费而不唤起模型。维护只预留接纳，不持串行线等待模型，stop 仍可取消压缩。

ConversationStore.close 只退订和排空输出，不 abort/dispose 会话；runtime 唯一停止并销毁控制器，最后关闭共享 Harness。根会话通道回报提示由 BackgroundReplies 保存于内存，与输入接纳和原生结果分开；不保证重启补发或平台恰好一次。

## 查询读取范围

- 调度和手动命令的活动检查不读回答正文，终态且无 native run 的执行不再读取 submission。
- 任务列表只读取每项任务的最新回答摘要，不遍历每条历史正文。
- 详情先过滤目标 binding，再投影一页，至多 50 条加分页 lookahead；后续页可额外读取最新执行以维持 latest 字段。
- 单项结果先验证 owner/task binding，再读取唯一目标回答。
- 所有映射只是本次事务内索引，不保存状态副本。原生存储没有业务 binding 索引，归属扫描仍随历史增长；不声称查询或启动内存是常量。

## 客户端所有权

应用只有一个 `features/shell/AppShell`，统一导航、键盘监听与推开动画。访问过的聊天保留各自 ChatProvider/useChat 和 ChatTab；owner-to-shell 通知只传当前聊天状态引用，不复制服务端执行状态，也不新增状态管理依赖。

隐藏聊天保留自身测量值，不能采用另一聊天输入框/键盘高度。切换聊天不改投 pending 输入，不丢草稿、附件、分页或滚动。Chat 导航返回 root；其他一级页观察 root。

抽屉使用同一个 Reanimated transition 管理动画与 underlay 挂载，完成关闭后卸载；中断动画不执行过期关闭回调，不再用独立 setTimeout 猜测动画结束。视觉尺寸、键盘抬升公式和按钮规范保持不变。

useChat 保留输入身份与重试协调，活动观察/健康检查和附件选择/上传分别由 useConversationObservation/useChatAttachments 负责；TasksScreen 的查询、命令身份和刷新状态由 useTasks 管理。小型视图状态不再机械拆 hook。

## 后续功能减法

技能固定扫描单层 `<目录>/SKILL.md`，不递归、不跟随链接目录/文件；保留元数据、路径校验和工作区覆盖。移除无消费者的 runtime HTTP 管理与独立 submission 查询路由，TG 直接调用的运行时能力、原生回执和去重不变。Posts 移除模拟数据展示空状态，历史仅投影原生用户/助手消息，不预留被动结果分支；设置按钮仍禁用，不提前暴露回调。TG/App 富文本实现及依赖未修改，保留流式 Markdown、分段与格式降级。

上述减法另以隔离 fixture 验证单层/嵌套/链接技能、同名覆盖、错误元数据和取消；已移除路由对 GET/POST 均返回 404，且不触达业务服务；原生回执/历史及 TG 控制继续回归。

## 固定回归协议

仓库不保留测试套件。验证使用临时工作区、Faux provider、真实 Durable Harness 和独立 localhost 页面；退出删除临时数据，绝不复用生产 PIKO_HOME。新增场景应按以下协议构造，可重复验证，而不是依赖人工碰撞竞争窗口。

| 场景 | 固定构造与预期 |
| --- | --- |
| 归档接纳竞争 | 用 Promise gate 持有子回答，在父 archive 操作中释放；预留期间 canReport=false，父不得处理报告；纯预留释放后可继续。实际业务归档另验证 epoch 失效、报告撤回及只读拒绝 |
| 查询放大 | 构造两个任务共 120 条终态历史，记录 entry 正文读取次数；latest=2，活动检查=0，首任务页=50，第二页=10+latest，单结果=1；跨任务结果/游标拒绝 |
| 流大小限制 | 不提供 Content-Length，分块发送跨过上限；返回 413 并 cancel，不能读完再检查；非法 JSON=400，非法对象=422，错误仍带 CORS |
| 观察关闭 | 给 controller 注入 abort/dispose 计数；Store.close 只退订，不调用这两项；runtime.dispose 仍取消和关闭原生工作 |
| 工具契约 | 5 个 subagent + 8 个 task，定义四字段必填，JSON 回执、旧入口拒绝、任务创建/更新/执行/停止/归档/恢复 |
| owner 隔离 | root 和两个旁聊分别委派；list/status/send/stop/报告仅属原 owner；后台不继承主聊天历史，不可嵌套或管理任务 |
| 强杀恢复 | 子进程有 pending foreground/side child 时 SIGKILL；重开撤回 steer、记录 owner-local interruption，不重放模型或工具，不污染 root |
| 持久化重开 | 不改原有 doc/字段/目录，重开读取任务、执行结果、主/旁聊历史和模型/工具选择，不依赖迁移或别名 |
| Telegram | 假 API 验证身份、按钮过期、模型/思考、输入/停止去重、消息编辑失败恢复；手动/阈值/溢出压缩 start/end 只通知已验证目标，不混入 SSE |
| 客户端切换 | root/side 分别输入草稿后往返；挂起旁聊 POST 后切 root，再释放请求，最终仍只入原旁聊；Tasks 往返不丢草稿或滚动 |
| 抽屉与布局 | 1024/390px 检查一份 Shell、推开不压缩内容；开/关/快速反向、Escape、露出表面点击、页签选择都收尾；控制台无异常 |

## 本轮验证记录

- API/mobile 类型检查和 diff 检查通过；本地值导入依赖扫描未发现循环，Markdown 相对链接检查通过。
- 13 组隔离脚本通过：归档竞争、查询读取范围、HTTP/观察生命周期、工具、任务 HTTP、旁聊、旁聊强杀、主会话/记忆回归、旧持久化重开、旁聊委派、旁聊子工作强杀恢复、TG 控制、压缩生命周期。
- 查询 fixture 验证了表中正文读取次数；它证明访问路径收敛，不是生产负载压测。
- Chromium 使用隔离 Faux 后端，验证主/旁聊草稿保留、旁聊 POST 挂起后切 root 再释放仍不改投、任务详情与执行记录、单一 Shell、390px 抽屉和快速反向关闭；构造 22 条长输入，在 1800px 历史位置往返高输入框旁聊/Tasks，滚动位置保持。关闭检测等待实际动画完成，不以固定 300ms 时限代替完成条件。
- Web/iOS/Android 导出用于检查打包依赖，不等同于原生键盘、无障碍或后台设备验证。
- 没有使用真实付费模型或真实 Telegram Bot 验收；Android/iOS 真机键盘、滚动、前后台与无障碍仍待验证。
