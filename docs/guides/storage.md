# Data and backups

English | [中文](storage.zh-CN.md)

By default, Piko keeps configuration, state and the workspace under `~/.piko`. `PIKO_HOME` selects a different absolute home, while `PIKO_WORKSPACE` may select a separate absolute workspace. Existing conversations record their working directory; changing it is not an automatic migration.

- `config/` contains private configuration and credentials.
- `state/durable/session.sqlite` is the Durable database. SQLite uses WAL and may also have `-wal` and `-shm` files.
- `state/attachments/` holds uploaded attachments; the default cleanup policy removes old attachments.
- `workspace/` contains assistant guidance, memory, skills and artifacts by default.

## Backup and restore

1. Stop the backend and ensure no other process is using the same `PIKO_HOME`.
2. Copy the complete private home, including the SQLite directory and any WAL/SHM files, plus any separately configured workspace. Protect the backup: it may contain credentials, conversation content, tool data and paths.
3. Restore the complete backup to a compatible deployment and the original workspace absolute path before starting. Existing conversations reject a mismatched workspace path. Do not run two backends on the same state directory; test restoration periodically.

Database corruption, unsupported old formats or a nonempty state directory missing the expected database cause startup to fail rather than silently create an empty session. There is no old-format import tool. Before upgrades, back up the complete home; data written by a newer runtime may not be readable by an older one. See the detailed [Chinese storage reference](../operations/storage.md).

## Deletion and retention

Deleting a side chat also cleans up its owned background work. Deleting a saved task removes its execution records and dedicated task directory; deleting a post removes its dedicated generation records. Side-chat and post deletion do not delete attachments, workspace files, artifacts or backups. Deletions do not undo external side effects or erase provider-side records.

Temporary background executions without a long-term owner are checked every 24 hours and reclaimed after seven days of inactivity, with active or unconsumed work skipped. Main conversation history, memory files and workspace artifacts are not removed by this retention policy. Attachments are cleaned up separately after 30 days; older message paths may then stop working.

Application deletion does not erase separate backups, filesystem snapshots or all storage media. Piko's workspace is a working directory, not a sandbox.
