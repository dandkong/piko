# 数据与备份

[English](storage.md) | 中文

Piko 默认把配置、状态和工作区放在 `~/.piko`。`PIKO_HOME` 可指定其他绝对路径，`PIKO_WORKSPACE` 可另行指定绝对工作区。已有会话记录工作目录；更换路径不是自动迁移。

- `config/` 包含私有配置和凭据。
- `state/durable/session.sqlite` 是 Durable 数据库；SQLite 使用 WAL，可能同时存在 `-wal` 和 `-shm` 文件。
- `state/attachments/` 存放上传附件；默认策略会清理旧附件。
- `workspace/` 默认保存助手指导、记忆、技能和产物。

为取得一致备份，先停止后端，再完整复制私有 home 和单独配置的工作区；备份与凭据一样需要保护。后端运行时不要只复制 SQLite 主文件。恢复时先把完整备份恢复到兼容部署，再启动；不要让两个后端共用同一状态目录。详见[存储说明](operations/storage.md)。

删除应用数据不会删除独立备份或文件系统快照。Piko 工作区是工作目录，不是沙箱。
