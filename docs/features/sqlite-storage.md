# Durable SQLite 存储迁移

状态：已切换原生 SQLite 后端；完成副本核验后，已对停止写入的线上 JSONL 重做迁移并切换，健康、主聊历史、旁聊列表、任务列表及 integrity_check 均正常，迁移前 JSONL 经核验后已按明确授权清除（包括历史备份中的旧 JSONL）；不能再回滚到这些已删除的旧存储。搜索尚未实现；旁聊永久删除已另行接入，范围见 [旁聊](side-chats.md)，不清理附件、工作区文件或历史备份。

## 边界

- 仍是一个 PIKO_HOME、一个 Harness/root。会话、entries、task、submission 和文档都由 Durable 原生 SQLite 保存；不新增消息正文、Run 表或双写层。
- 固定文件为 `PIKO_HOME/state/durable/session.sqlite`。运行时使用 SDK 的 `SqliteStorage` 和 Node SQLite 适配器（已验证 Bun 兼容），WAL、`synchronous=FULL`、`secure_delete=ON`。
- 数据目录权限 700，数据库及已创建的 WAL/SHM 权限 600。FULL 保留原先 JSONL fsync 的持久性意图。
- 当前目录若包含 JSONL 明确拒绝启动；非空目录缺失数据库同样拒绝创建空会话。不自动迁移、不静默回退、不在同一运行目录保留两份可选事实源。
- 后端原有单进程锁、接纳线、重启不重放和回报恢复语义不变。

## 显式迁移

在源码根目录运行：

```bash
bun scripts/migrate-storage.ts /absolute/source-jsonl-directory /absolute/new-sqlite-directory
```

目标目录必须不存在，且不能位于源目录内部。脚本不编辑原目录：先复制到权限 700 的私有暂存区，核对复制期间 main.jsonl 未变化，然后让 SDK 验证及恢复副本。真实切换必须停止写入进程后重做迁移，不能把早先的试验副本直接当最新状态上线。

导入器只支持当前 Durable JSONL format 1 和连续 commit 序列；未知布局或缺失必要 sidecar 直接失败。按照 SDK 的回收规则处理已结算任务 checkpoint、current-only 文档的旧版本和已退休文档，不尝试恢复源存储本来就未保留的内容。使用 SQLite Storage.commit 按原序列导入，不重新生成业务 ID，不压缩为一份丢失历史的当前快照。

未发布的导入暂存库使用适配器默认 NORMAL，避免逐个 fsync 数万次历史提交；最终关闭/checkpoint、以 FULL 重新打开并验证后才发布目标目录。失败不覆盖既有目标，不修改源；强杀时可能留下 `.piko-migration-*` 私有暂存目录，需要显式清理。

校验包括：

- 所有会话、原生任务和 submission 的完整记录。
- 每条 entry 及其原始 commit sequence，每个会话的可见历史。
- 所有文档的当前状态及源保留的 rewindable 文档变更点。
- 关闭数据库并重新打开后重复核验。
- 目标写入不含消息正文的 `migration.json`，记录源 main 摘要、时间和核对数量。

## 停机切换与回滚

1. 停止后端，确认没有第二个进程写同一状态目录。
2. 对静止的原目录运行迁移，输出到单独的新目录。
3. 保存原目录作为明确的迁移备份，将新目录移动到 `state/durable`，再启动 SQLite 版代码。
4. 验证健康、会话/任务列表、消息历史、输入去重及后台恢复。任何切换后产生的新写入仅在 SQLite；旧 JSONL 不会同步。
5. 仅在原 JSONL 备份仍存在时可成套回滚代码和原目录，且会丢失切换后的新写入。当前部署已明确授权清除旧 JSONL，不再具备这条回滚路径；不能把仅回滚代码当成数据库回滚。

备份应在停止后端后成套复制整个数据库目录及工作区；不得只复制运行中的主数据库文件而漏掉 WAL。旧 JSONL 和旧备份仍含原始隐私内容；迁移不是删除，也不会自动擦除它们。

## 对永久删除与搜索的验证结论

SQLite 支持按 conversation_id、owner task、文档 scope 等定位记录，适合作为后续归属清理和查询的基础。SDK 目前没有整会话永久删除 API，因此 Piko 的维护适配器先通过原生 retireDoc 清除跟踪缓存，再在 Harness mutation line 上操作同一数据库连接，不能直接并行打开第二个写入连接 DELETE。

离线副本验证：通过 Harness 写入专门的隐私探针会话，关闭 Harness 后事务清除该会话和 entry，checkpoint/VACUUM 后数据库及 WAL 不再包含探针文本；主会话历史、原任务和 submission 不变，integrity_check 为 ok，重新打开后会话确实不存在。

离线试验只证明存储层可行。随后接入的旁聊删除覆盖父/子执行、回执、文档、缓存、写入门禁和中断恢复；按确认边界，不清理附件、共享工作区文件或备份，也不回滚外部副作用。secure_delete 不是对文件系统快照、SSD 历史块或旧备份的安全擦除保证。

已确认当前 SQLite 构建包含 FTS5。此轮没有创建搜索索引、接入搜索 API 或向量服务；后续可基于同一原始 entries 构建可删除的派生索引，中文检索需单独评估。

## 已完成验证

- 真实数据副本：43,938 次 commit、68 个会话、3,847 条 entries、3,504 个原生 task、339 个 submission、783 个文档，95 个保留文档历史点；导入前后和关闭重开后核验一致。这是试验快照数量，不是线上永久计数。
- SQLite 下主聊委派与私有回传、旁聊历史和记忆隔离回归通过。
- 旁聊后台执行重启取消、不重放、不回主聊的回归通过。
- 保存任务 HTTP 创建去重、完整更新、归档/恢复契约回归通过。
- 停机重做迁移并上线后，原始 JSONL 曾成套移入私有回滚备份供核验；后续已按明确授权清除 PIKO_HOME 内 8 处备份目录中的 5,219 个旧 JSONL/回收残留文件，确认不再存在 JSONL。其他备份文件、配置、附件和工作区未随此清理删除。
- 离线旁聊归属清理试验删除 1 个旁聊、17 个原生 task 和 8 个文档，主聊历史保持不变，integrity_check 为 ok；该样本未覆盖有嵌套子会话的全部场景，此项离线试验本身不作为在线级联删除功能的证明；在线删除另有运行中子 Agent、主聊不受影响、失败重试和重启恢复回归。
