# 旁聊

状态：首版已实现；Web 与临时模拟模型验证通过，原生设备行为仍需验证。旁聊是用户直接使用的独立聊天，不是主聊天分支、保存任务或后台工作。

## 产品范围

- 抽屉右下一键新建旁聊，使用默认名“新旁聊”并直接进入，不先填写名称。每行标题左对齐，右侧“⋯”菜单提供重命名和归档；重命名使用通用输入弹窗，预填当前名，确认后保存，取消不修改，不在列表原地编辑，限制 1–100 字。顶部头像旁始终显示 Piko，不随聊天名称变化。
- Chat 一级导航始终回到主会话。应用重开默认主会话，不把旁聊提升为新的一级模块。
- 每个旁聊有自己的历史、上下文、模型选择、输入去重、停止与压缩状态。新建时复制主会话当前模型/思考选择，之后独立，不增加新的配置角色位。
- 不 fork 主会话，不继承其聊天记录，不自动回传、合并或推送主会话；Telegram 仍只接主会话。
- 共享同一工作区和动态资源 section：AGENTS.md、MEMORY.md、技能及通用文件/命令/网络工具。记忆不是创建时的副本，后续请求会加载最新工作区记忆。
- 不向旁聊提供 `task_*`、`subagent_*` 系列工具；不为旁聊启动记忆整理，也不将旁聊历史纳入主会话的每日/长期记忆增量。模型自动上下文压缩仍可正常工作，不是记忆提取。
- 共享工具依然使用服务进程本机权限，不构成文件沙箱；不提供任务管理工具/自动记忆整理，不代表 write/edit/bash 无法触及对应文件。
- 归档会先停止该旁聊并撤回其未应用输入，再标记归档；历史和底层日志保留，拒绝新输入。客户端隐藏已归档旁聊，不提供已归档列表或恢复入口；归档当前旁聊后回到主聊天。原有 API 的恢复能力保留，但不对客户端提供入口。归档与提交共用该会话的接纳线，避免“归档后又接纳输入”的竞争。

## 运行时

`server/runtime/pi.ts` 持有唯一 Storage/Harness/Registry，启动主会话专属的任务和记忆服务。`pi-session.ts` 仅绑定一个原生 Conversation，负责输入、停止、维护、历史投影及事件观察；会话控制器关闭不关闭 Harness。

```text
PikoRuntime（唯一 Harness、JSONL、共享资源）
├── root → DurableChatSession → ConversationStore → App / Telegram
├── ownerless 旁聊 → DurableChatSession → ConversationStore → App
├── owned 后台子会话 → Anchor / Reporter → root
└── 主会话专属任务与记忆整理服务
```

旁聊使用原生 ownerless Conversation。`piko.side-chat` 是 conversation Doc，只保存 title、createdAt、archivedAt；`piko.side-chat-creates` 是 session Doc family，按创建 requestId 保存原生 ID 回执，创建和回执在同一个 commit。列表由原生 Conversation + 该标记投影，不混入 owned 子会话，也不建立独立 Thread、Run 或消息存储。

所有聊天读取及来源标记显式按 conversation ID 隔离。只有确实带旁聊标记的 Conversation 可经旁聊 API 访问，root/后台子会话不能凭 ID 被冒充为旁聊。原生 ID 对外视为不透明字符串。

后台工具范围复用统一的受限 scope，但旁聊不使用后台模型角色，不注册 Anchor/Reporter，不共享其生命周期。启动刷新旁聊的通用工具范围，不覆盖已保存模型或聊天历史。

## HTTP

| 接口 | 行为 |
| --- | --- |
| GET /api/side-chats | 返回全部旁聊元数据（含 archivedAt），客户端过滤归档 |
| POST /api/side-chats | `{requestId,title}`，幂等创建；返回旁聊元数据 |
| POST /api/side-chats/:id | `{title? ,archived?}`，改名/归档/恢复 |
| GET /api/side-chats/:id/chat | 最近聊天快照 |
| GET /api/side-chats/:id/chat/history?before=… | 向前分页 |
| GET /api/side-chats/:id/chat/events | 首帧快照 + SSE 更新 |
| GET /api/side-chats/:id/chat/submission?requestId=… | 本会话接纳回执 |
| POST /api/side-chats/:id/chat | `{requestId,message,attachmentIds?}` |
| POST /api/side-chats/:id/chat/stop | `{requestId}`，只停止该会话 |

主聊天仍为 `/api/chat`；已有 `/api/runtime` 管理入口和 Telegram 模型命令仍作用于主会话。运行时内部可按 conversation ID 描述/选择/压缩，首版未增加旁聊的模型管理 UI。

## 前端状态与恢复

访问过的聊天按 ID 保留独立 ChatProvider/useChat 和视图实例，草稿、附件、分页历史、滚动状态及正在发送的请求不会因切换而改投另一个会话；仅当前显示的会话观察 SSE。停止观察不停止模型工作，再次进入通过最新快照恢复。其他一级页面显示主聊天的 Shell，Chat 按钮始终返回 root。

旁聊元数据在打开抽屉时重新读取；列表只展示未归档旁聊。客户端本机归档会移除该聊天的保留视图，并在归档当前聊天时返回主会话。跨设备归档由后端强制拒绝后续输入，元数据在下次抽屉刷新时更新。草稿和选中旁聊不跨应用重开持久化。

启动在调度前检查主/旁聊和后台会话，撤回遗留输入，取消不确定执行。为受影响聊天保存中断提示，不重放模型或工具；后台已完成结果仍沿用原 Reporter 恢复规则。退出关闭各聊天观察/控制器，最后由运行时统一关闭 Harness。

## 验证

使用临时工作区、Faux provider 和单独 localhost 服务，不调用真实模型、不写正式数据：

- 服务端/客户端类型检查；Web 导出到临时目录。
- 创建请求去重；两旁聊与 root 共用 Harness，但历史、分页、同名 requestId 和停止互不干扰。
- 同一份记忆与技能确实进入旁聊模型请求；无主会话上下文，无任务管理/委派工具。
- HTTP root/未知 ID 拒绝，归档期间停止、只读访问、拒绝输入和恢复。
- 关闭重开后元数据、历史、工具范围保留，不自动调用模型。
- 强杀独立验证进程后重开：旁聊遗留执行取消，未应用 steer 撤回，只在受影响旁聊显示中断，不重放模型、不误标记 root。
- Chromium 真页面验证一键默认名新建、发送、切换、主/旁聊草稿保留、历史隔离、三点菜单重命名/归档、头像身份固定 Piko、归档后隐藏且无恢复入口、当前旁聊归档后返回主会话；菜单 Escape 只关闭菜单；390px Web 布局检查。标题左对齐与通用输入弹窗已验证：预填、取消/外点/Escape 不保存、空白禁用、确认/Enter 保存、模拟保存失败后保留输入与重试；桌面 1280px 和 390px Web 均通过，原生键盘行为仍待真机验证。
- 主会话后台委派与私下回传回归通过；后台子会话不能通过旁聊 ID 访问；旁聊运行不修改 root 的记忆整理活动状态。

未验证：Android/iOS 真机键盘与后台、真实模型的长对话压缩、真实 Telegram 网络回归。没有为这些范围声称通过。
