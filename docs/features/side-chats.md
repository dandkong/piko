# 旁聊

状态：旁聊已实现，支持独立历史、后台委派和确认后删除；Web 与隔离模拟环境已覆盖主要行为。Android/iOS 真机、真实模型与 Telegram 网络行为尚未验证。旁聊是用户直接使用的独立聊天，不是主聊天分支、保存任务或后台工作。

## 产品范围

- 抽屉右下一键新建旁聊并直接进入，不先填写名称；新旁聊的存储标题初始为空，界面以“新旁聊”兜底显示。每行标题左对齐，右侧“⋯”菜单提供“生成标题”和删除。每次成功回答结束后，客户端检查标题；仅为空时异步请求生成标题，已有标题不自动改写。自动生成失败且标题仍为空时，后续回答结束可再次尝试；用户可从菜单手动重新生成并覆盖标题。标题根据最近一轮用户/助手文本生成，不含工具内容，每条输入最多取前 500 个 Unicode 字符，生成标题最多 100 个字符；标题请求不阻塞聊天。
- Chat 一级导航始终回到主会话。应用重开默认主会话，不把旁聊提升为新的一级模块。
- 每个旁聊有独立历史、上下文、输入去重、停止与压缩状态。主聊和所有旁聊共用全局主模型及思考强度；切换在空闲或下一轮接纳边界生效，已运行的一轮不切换。
- 不 fork 主会话，不继承其聊天记录，不自动回传、合并或推送主会话；Telegram 仍只接主会话。
- 共享同一工作区和动态资源 section：AGENTS.md、MEMORY.md、技能及通用文件/命令/网络工具。记忆不是创建时的副本，后续请求会加载最新工作区记忆。
- 旁聊不提供 `task_*` 任务管理工具，但可使用 `subagent_*` 委派后台工作。`sessions_search` / `sessions_history` 只访问当前旁聊，不能搜索主会话或其他旁聊；后台子 Agent 不提供这两个工具。子 Agent、列表、停止及回报都限制在发起它的旁聊；报告只回该旁聊，不进入主会话或 Telegram。删除旁聊会停止并清理其所属后台工作。
- 不为旁聊启动记忆整理，也不将旁聊历史纳入主会话的每日/长期记忆增量。模型自动上下文压缩仍可正常工作，不是记忆提取。
- 共享工具依然使用服务进程本机权限，不构成文件沙箱；不提供任务管理工具/自动记忆整理，不代表 write/edit/bash 无法触及对应文件。
- 删除是不可恢复的操作，需要确认弹窗；先封住输入和内部回报，停止并等待旁聊及所属后台执行结束，再清理当前存储和缓存。删除当前旁聊后回到主聊天。旁聊不提供归档或恢复 API；保存任务的归档/恢复不受影响。

列表加载错误与创建/标题生成/删除错误分开：读取可原位重试，加载/失败时不显示空态；删除失败只留在确认框，取消后不在抽屉背景报第二次错。详见[错误反馈与恢复](error-feedback.md)。

## 运行时

`server/runtime/pi.ts` 持有唯一 Storage/Harness 和服务生命周期，`bootstrap.ts` 在 resume 前完成恢复和策略刷新；`side-chat-service.ts` 管旁聊创建、标题生成和删除规则。Reporter 按原生 task 的 conversationId 回到发起会话的接纳线。`conversation-session.ts` 是单会话 facade，`conversation-control.ts` 管输入、停止、维护、删除及内部报告，`conversation-view.ts` 管历史投影和事件观察；控制器不关闭 Harness，观察 Store 不停止或销毁控制器。

```text
PikoRuntime（唯一 Harness、Durable SQLite、共享资源）
├── root → DurableChatSession → ConversationStore → App / Telegram
├── ownerless 旁聊 → DurableChatSession → ConversationStore → App
├── owned 后台子会话 → Anchor / Reporter → 发起它的 root 或旁聊
└── 主会话专属任务与记忆整理服务
```

旁聊使用原生 ownerless Conversation。`piko.side-chat` conversation Doc 保存标题和创建时间；`piko.side-chat-creates` session Doc family 按创建 requestId 保存原生 ID 回执，创建和回执在同一个 commit。列表由原生 Conversation 与该标记投影，不混入 owned 子会话，也不建立独立 Thread、Run 或消息存储。

所有聊天读取及来源标记显式按 conversation ID 隔离。只有确实带旁聊标记的 Conversation 可经旁聊 API 访问，root/后台子会话不能凭 ID 被冒充为旁聊。原生 ID 对外视为不透明字符串。

普通后台子 Agent 使用受限 scope，不能继续委派或管理任务。旁聊保留 `subagent_*` 工具但移除 `task_*`；发起委派时创建由该旁聊拥有的 Anchor/Reporter，状态查询和停止按 owner conversation 隔离。后台模型使用显式 `agent.profiles.background`；未配置时动态跟随全局主模型，可单独覆盖思考强度，不按旁聊当时的 AgentDoc 选择。报告只以隐藏 follow-up 提交回发起旁聊，不触发主会话回传或 Telegram 投递。启动刷新旁聊工具和提示词，并将前台模型对齐全局主模型，不修改聊天历史。删除在同一会话接纳线内预留，但等待后台退出时不占住串行线，避免等待该线的 Reporter 死锁；内部报告同样通过该线重新检查可写与取消 epoch，避免检查后再直接原生 submit 的竞争。

## HTTP

| 接口 | 行为 |
| --- | --- |
| GET /api/side-chats | 返回可用旁聊的 id/title/createdAt，不含旧归档项 |
| POST /api/side-chats | `{requestId}`，幂等创建空标题旁聊；返回旁聊元数据 |
| POST /api/side-chats/:id/title/generate | `{requestIds?, onlyIfEmpty?}`，根据指定的最近一轮或最新已完成的一轮生成标题；`onlyIfEmpty: true` 时已有标题则直接返回；未指定时，带 `requestIds` 的自动请求只填空标题，手动请求会覆盖；返回旁聊元数据 |
| DELETE /api/side-chats/:id | 不可恢复删除；成功 204；已删除 ID 重试安全；root/后台子会话拒绝 |
| GET /api/side-chats/:id/chat | 最近聊天快照 |
| GET /api/side-chats/:id/chat/history?before=… | 向前分页 |
| GET /api/side-chats/:id/chat/events | 首帧快照 + SSE 更新 |
| POST /api/side-chats/:id/chat | `{requestId,message,attachmentIds?}` |
| POST /api/side-chats/:id/chat/stop | `{requestId}`，只停止该会话 |

主聊天使用 `/api/chat`；Telegram 模型命令作用于主会话。内部可按 conversation ID 描述、选择和压缩；HTTP 不开放独立 runtime 管理或 submission 查询入口，旁聊也没有模型管理 UI。输入 POST 回执、快照与相同 requestId 重试遵循原生去重语义。

## 永久删除边界

清理旁聊及其所有权子树的 entries（含模型/工具/思考等原始记录）、submissions、tasks、会话/任务文档及其历史、创建回执、服务端控制器/观察缓存和在线客户端状态。先以原生 retireDoc 使 Session 文档缓存失效，再在同一 Harness mutation line、同一个原生数据库连接上执行物理事务删除；ID/commit 游标保持单调，不复用删除的 ID。成功前执行 WAL truncate、VACUUM、再 truncate；不绕开活跃 Harness 并行打开第二个写入连接。

停止仅作用于删除目标的所有权子树，不关闭整个 Harness，也不取消正在输出的主聊或其他旁聊。若存在继承目标历史但不属于该树的 fork，拒绝删除，等待显式 fork 策略。原生 schema 版本不匹配时拒绝执行维护 SQL。

旁聊删除标记保存业务删除意图；物理退休和删除统一使用 `piko.storage-deletion` ID 计划，无正文的 `piko.storage-cleanup` 标记记录物理删除完成但 WAL 清理尚未完成的状态。尚未删除的旁聊及其所属后台工作不套主会话临时工作的 7 天 TTL。共用机制见[存储维护](../operations/storage.md#共用删除协议)。启动在 Harness resume 之前完成剩余清理，不重放模型或工具。物理删除/清理失败不报成功，允许重试。

不删除附件、工作区文件、产物、全局记忆、备份或供应商侧记录，不回滚工具外部副作用；不会清理主聊、其他旁聊、保存任务定义及其执行。这里的永久删除是当前运行系统内的会话/执行数据删除，不是所有介质的安全擦除。会话检索直接扫描 Durable entries，当前没有持久化搜索索引。

## 前端状态与恢复

访问过的聊天按 ID 保留独立 ChatProvider/useChat，草稿、附件、分页历史及正在发送的请求不会因切换而改投另一个会话；只挂载当前可见聊天的消息列表，切走即卸载列表，切回在布局就绪后滚到最新，不保存跨切换的阅读位置或列表测量值。Chat 页面只观察当前聊天；其他一级页面保持 root 观察。停止观察不停止模型工作，再次进入通过最新快照恢复。应用只保留一份 Shell/推开动画。会话内向上阅读暂停跟随，回到底部或点击“最新消息”恢复跟随，流式富文本不变。Chat 按钮始终返回 root。

旁聊元数据在打开抽屉时重新读取。删除成功会移除该聊天的 Provider/草稿/附件引用/历史，当前旁聊返回主会话。服务端发出 deleted SSE 并关闭订阅；在线客户端清空对应状态。未订阅的旧客户端下次打开若收到旁聊 404，同样清空并停止重连。删除不清除离线设备或浏览器外部保存的副本。草稿和选中旁聊不跨应用重开持久化。

启动在调度前检查主/旁聊和后台会话，撤回遗留输入，取消不确定执行。为受影响聊天保存中断提示，不重放模型或工具；后台已完成结果仍沿用原 Reporter 恢复规则。退出关闭各聊天观察/控制器，最后由运行时统一关闭 Harness。

## 验证状态

主要服务端行为与 Web 交互已在隔离环境覆盖，包括创建/重命名/删除、历史与停止隔离、权限归属、后台委派范围和删除后的恢复边界。自动标题的空标题判断、并发和手动覆盖使用隔离模拟检查。验证不调用真实模型或真实 Bot。

Android/iOS 真机键盘与后台行为、无障碍体验、真实模型长对话和 Telegram 网络行为尚未验证。
