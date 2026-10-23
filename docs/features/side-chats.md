# 旁聊

状态：首版已实现；Web 与临时模拟模型验证通过，原生设备行为仍需验证。旁聊是用户直接使用的独立聊天，不是主聊天分支、保存任务或后台工作。

## 产品范围

- 抽屉右下一键新建旁聊，使用默认名“新旁聊”并直接进入，不先填写名称。每行标题左对齐，右侧“⋯”菜单提供重命名和删除；重命名使用通用输入弹窗，预填当前名，确认后保存，取消不修改，不在列表原地编辑，限制 1–100 字。顶部头像旁始终显示 Piko，不随聊天名称变化。
- Chat 一级导航始终回到主会话。应用重开默认主会话，不把旁聊提升为新的一级模块。
- 每个旁聊有自己的历史、上下文、模型选择、输入去重、停止与压缩状态。新建时复制主会话当前模型/思考选择，之后独立，不增加新的配置角色位。
- 不 fork 主会话，不继承其聊天记录，不自动回传、合并或推送主会话；Telegram 仍只接主会话。
- 共享同一工作区和动态资源 section：AGENTS.md、MEMORY.md、技能及通用文件/命令/网络工具。记忆不是创建时的副本，后续请求会加载最新工作区记忆。
- 旁聊不提供 `task_*` 任务管理工具，但可使用 `subagent_*` 委派后台工作。子 Agent、列表、停止及回报都限制在发起它的旁聊；报告只回该旁聊，不进入主会话或 Telegram。删除旁聊会停止并清理其所属后台工作。
- 不为旁聊启动记忆整理，也不将旁聊历史纳入主会话的每日/长期记忆增量。模型自动上下文压缩仍可正常工作，不是记忆提取。
- 共享工具依然使用服务进程本机权限，不构成文件沙箱；不提供任务管理工具/自动记忆整理，不代表 write/edit/bash 无法触及对应文件。
- 删除是不可恢复的操作，需要确认弹窗；先封住输入和内部回报，停止并等待旁聊及所属后台执行结束，再清理当前存储和缓存。删除当前旁聊后回到主聊天。旁聊不再提供归档或恢复 API；保存任务的归档/恢复不受影响。

## 运行时

`server/runtime/pi.ts` 持有唯一 Storage/Harness 和服务生命周期，`bootstrap.ts` 在 resume 前完成恢复和策略刷新；`side-chat-service.ts` 管旁聊创建、改名和删除规则。Reporter 按原生 task 的 conversationId 回到发起会话的接纳线。`conversation-session.ts` 是单会话 facade，`conversation-control.ts` 管输入、停止、维护、删除及内部报告，`conversation-view.ts` 管历史投影和事件观察；控制器不关闭 Harness，观察 Store 不停止或销毁控制器。

```text
PikoRuntime（唯一 Harness、Durable SQLite、共享资源）
├── root → DurableChatSession → ConversationStore → App / Telegram
├── ownerless 旁聊 → DurableChatSession → ConversationStore → App
├── owned 后台子会话 → Anchor / Reporter → 发起它的 root 或旁聊
└── 主会话专属任务与记忆整理服务
```

旁聊使用原生 ownerless Conversation。`piko.side-chat` 是 conversation Doc，保存 title、createdAt，原有 archivedAt 仅保留作旧数据识别，不再对外提供归档状态；`piko.side-chat-creates` 是 session Doc family，按创建 requestId 保存原生 ID 回执，创建和回执在同一个 commit。列表由原生 Conversation + 该标记投影，不混入 owned 子会话，也不建立独立 Thread、Run 或消息存储。

所有聊天读取及来源标记显式按 conversation ID 隔离。只有确实带旁聊标记的 Conversation 可经旁聊 API 访问，root/后台子会话不能凭 ID 被冒充为旁聊。原生 ID 对外视为不透明字符串。

普通后台子 Agent 使用受限 scope，不能继续委派或管理任务。旁聊保留 `subagent_*` 工具但移除 `task_*`；发起委派时创建由该旁聊拥有的 Anchor/Reporter，状态查询和停止按 owner conversation 隔离。后台模型角色仍按 `agent.profiles.background` 选择，未配置时继承发起旁聊当前模型。报告只以隐藏 follow-up 提交回发起旁聊，不触发主会话回传或 Telegram 投递。启动刷新旁聊工具和提示词，不覆盖已保存模型或聊天历史。删除在同一会话接纳线内预留，但等待后台退出时不占住串行线，避免等待该线的 Reporter 死锁；内部报告同样通过该线重新检查可写与取消 epoch，避免检查后再直接原生 submit 的竞争。

## HTTP

| 接口 | 行为 |
| --- | --- |
| GET /api/side-chats | 返回可用旁聊的 id/title/createdAt，不含旧归档项 |
| POST /api/side-chats | `{requestId,title}`，幂等创建；返回旁聊元数据 |
| POST /api/side-chats/:id | `{title}`，仅改名；archived 字段拒绝 |
| DELETE /api/side-chats/:id | 不可恢复删除；成功 204；已删除 ID 重试安全；root/后台子会话拒绝 |
| GET /api/side-chats/:id/chat | 最近聊天快照 |
| GET /api/side-chats/:id/chat/history?before=… | 向前分页 |
| GET /api/side-chats/:id/chat/events | 首帧快照 + SSE 更新 |
| POST /api/side-chats/:id/chat | `{requestId,message,attachmentIds?}` |
| POST /api/side-chats/:id/chat/stop | `{requestId}`，只停止该会话 |

主聊天仍为 `/api/chat`；Telegram 模型命令作用于主会话。内部仍可按 conversation ID 描述/选择/压缩，但没有独立 runtime HTTP 管理或 submission 查询入口，也未增加旁聊的模型管理 UI。输入 POST 回执、快照与相同 requestId 重试保留原有去重语义。

## 永久删除边界

清理旁聊及其所有权子树的 entries（含模型/工具/思考等原始记录）、submissions、tasks、会话/任务文档及其历史、创建回执、服务端控制器/观察缓存和在线客户端状态。先以原生 retireDoc 使 Session 文档缓存失效，再在同一 Harness mutation line、同一个原生数据库连接上执行物理事务删除；ID/commit 游标保持单调，不复用删除的 ID。成功前执行 WAL truncate、VACUUM、再 truncate；不绕开活跃 Harness 并行打开第二个写入连接。

停止仅作用于删除目标的所有权子树，不关闭整个 Harness，也不取消正在输出的主聊或其他旁聊。若存在继承目标历史但不属于该树的 fork，拒绝删除，等待显式 fork 策略。原生 schema 版本不匹配时拒绝执行维护 SQL。

已退休的旁聊标记作为中断删除的恢复意图；另有无正文的 piko.storage-cleanup 标记，覆盖物理删除完成但 WAL 清理尚未完成的中断。启动在 Harness resume 之前完成剩余清理，不重放模型或工具。物理删除/清理失败不报成功，允许重试。

不删除附件、工作区文件、产物、全局记忆、备份或供应商侧记录，不回滚工具外部副作用；不会清理主聊、其他旁聊、保存任务定义及其执行。这里的永久删除是当前运行系统内的会话/执行数据删除，不是所有介质的安全擦除。未来搜索索引须随删除清理，本轮没有搜索功能。

## 前端状态与恢复

访问过的聊天按 ID 保留独立 ChatProvider/useChat，草稿、附件、分页历史及正在发送的请求不会因切换而改投另一个会话；只挂载当前可见聊天的消息列表，切走即卸载列表，切回在布局就绪后滚到最新，不保存跨切换的阅读位置或列表测量值。Chat 页面只观察当前聊天；其他一级页面保持 root 观察。停止观察不停止模型工作，再次进入通过最新快照恢复。应用只保留一份 Shell/推开动画。会话内向上阅读暂停跟随，回到底部或点击“最新消息”恢复跟随，流式富文本不变。Chat 按钮始终返回 root。

旁聊元数据在打开抽屉时重新读取。删除成功会移除该聊天的 Provider/草稿/附件引用/历史，当前旁聊返回主会话。服务端发出 deleted SSE 并关闭订阅；在线客户端清空对应状态。未订阅的旧客户端下次打开若收到旁聊 404，同样清空并停止重连。删除不清除离线设备或浏览器外部保存的副本。草稿和选中旁聊不跨应用重开持久化。

启动在调度前检查主/旁聊和后台会话，撤回遗留输入，取消不确定执行。为受影响聊天保存中断提示，不重放模型或工具；后台已完成结果仍沿用原 Reporter 恢复规则。退出关闭各聊天观察/控制器，最后由运行时统一关闭 Harness。

## 验证

使用临时工作区、Faux provider 和单独 localhost 服务，不调用真实模型、不写正式数据：

- 服务端/客户端类型检查；Web 导出到临时目录。
- 创建请求去重；两旁聊与 root 共用 Harness，但历史、分页、同名 requestId 和停止互不干扰。
- 同一份记忆与技能确实进入旁聊模型请求；无主会话上下文及任务管理工具，包含独立的后台委派工具。
- DELETE/改名/CORS 契约、归档字段拒绝、root/后台子会话保护、幂等删除重试、旧链接 404、SSE deleted/关闭与客户端停止重连。
- 关闭重开后元数据、历史、工具范围保留，不自动调用模型。
- 强杀独立验证进程后重开：旁聊遗留执行取消，未应用 steer 撤回，只在受影响旁聊显示中断，不重放模型、不误标记 root。
- 消息列表生命周期简化后，API/mobile 类型检查和 Web 导出通过；Chromium 真页面在桌面与 390px 宽度验证任一时刻仅一个聊天列表、主/旁聊切回到底部、短距离向上滚动不吸回、点击“最新消息”返回底部；CDP 模拟触摸拖动可以离开底部。简化与额外 touch-start 补丁未解决实际设备的回弹表现，touch-start 补丁已撤回。后续实测确认共用底部容器按会话缓存高度会使旁聊采用 0 高度，造成底部留白不足、渐隐错位和“最新消息”按钮被导航遮挡；现已改为一份共用实测高度，用户确认恢复正常。按钮取消点击时提前隐藏，Chromium 页面记录确认滚动期间无隐藏/重现，到底后只隐藏一次。
- Chromium 真页面验证一键默认名新建、发送、切换、主/旁聊草稿保留、历史隔离、三点菜单重命名、头像身份固定 Piko；旧版归档验证不代表当前删除验证；菜单 Escape 只关闭菜单；390px Web 布局检查。标题左对齐与通用输入弹窗已验证：预填、取消/外点/Escape 不保存、空白禁用、确认/Enter 保存、模拟保存失败后保留输入与重试；桌面 1280px 和 390px Web 均通过，原生键盘行为仍待真机验证。
- 主会话与旁聊后台委派均回传到各自 owner；旁聊列表/状态/停止只见本旁聊子 Agent，不能通过旁聊 ID 访问其他 owned 会话；删除停止该旁聊子 Agent；旁聊运行不修改 root 的记忆整理活动状态。
- 删除旁聊和委派子会话后，原生文档缓存无残留，旧控制器拒绝发送，重启不恢复；主聊历史与工作区文件不变，数据库/WAL 中的专用隐私探针消失。
- 正在运行的旁聊子 Agent 可取消并完成删除，主聊仍继续输出；模拟物理 purge 失败可重试，模拟 purge/checkpoint 前中断后重开会自动完成清理，其他旁聊不变。

未验证：Android/iOS 真机键盘与后台、真实模型的长对话压缩、真实 Telegram 网络回归。没有为这些范围声称通过。
