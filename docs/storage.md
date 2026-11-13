# Data and backups

English | [中文](storage.zh-CN.md)

By default, Piko keeps configuration, state and the workspace under `~/.piko`. `PIKO_HOME` selects a different absolute home, while `PIKO_WORKSPACE` may select a separate absolute workspace. Existing conversations record their working directory; changing it is not an automatic migration.

- `config/` contains private configuration and credentials.
- `state/durable/session.sqlite` is the Durable database. SQLite uses WAL and may also have `-wal` and `-shm` files.
- `state/attachments/` holds uploaded attachments; the default cleanup policy removes old attachments.
- `workspace/` contains assistant guidance, memory, skills and artifacts by default.

For a consistent backup, stop the backend and copy the complete private home and any separately configured workspace. Protect backups as carefully as credentials. Do not copy only the SQLite main file while the backend is running. Restore a complete backup to a compatible deployment before starting; do not run two backends on the same state directory. See the detailed [Chinese storage reference](operations/storage.md).

Deleting application data does not remove separate backups or filesystem snapshots. Piko's workspace is a working directory, not a sandbox.
