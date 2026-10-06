import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MainConversation } from "../../shared/domain/chat";
import type { RunSnapshot, RunStatus } from "../../shared/chat";
import type { SessionContext } from "../runtime/types";

type ThreadRow = { id: string; workspace_id: string; kind: "main" | "side"; parent_thread_id: string | null;
  created_at: number; runtime_json: string | null };
type RunRow = { id: string; thread_id: string; input_hash: string; status: RunStatus; created_at: number;
  last_event_id: number; error: string | null; error_code: "interrupted" | null; retry_of_run_id: string | null };
export type RunRecord = Omit<RunSnapshot, "message" | "text"> & { inputHash: string };

export function submissionHash(message: string): string { return createHash("sha256").update(message).digest("hex"); }
function record(row: RunRow): RunRecord {
  return { id: row.id, status: row.status, createdAt: row.created_at, lastEventId: row.last_event_id,
    inputHash: row.input_hash, ...(row.error && { error: row.error }), ...(row.error_code && { errorCode: row.error_code }),
    ...(row.retry_of_run_id && { retryOfRunId: row.retry_of_run_id }) };
}

/** Only identities and execution metadata live here. Pi owns all conversation content. */
export class ChatRepository {
  readonly db: Database;
  readonly main: MainConversation;

  constructor(databasePath: string, workspacePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath, { create: true, strict: true });
    try {
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version !== 0 && version !== 3) throw new Error("Incompatible development database. Stop Piko and use a new PIKO_HOME; old data is not migrated or deleted.");
      if (version === 0) this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
          CREATE TABLE threads (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
            kind TEXT NOT NULL CHECK(kind IN ('main','side')), parent_thread_id TEXT REFERENCES threads(id),
            created_at INTEGER NOT NULL, runtime_json TEXT,
            CHECK((kind='main' AND parent_thread_id IS NULL) OR (kind='side' AND parent_thread_id IS NOT NULL)));
          CREATE UNIQUE INDEX one_main_thread ON threads(workspace_id) WHERE kind='main';
          CREATE TRIGGER side_parent_insert BEFORE INSERT ON threads WHEN NEW.kind='side'
            AND NOT EXISTS (SELECT 1 FROM threads WHERE id=NEW.parent_thread_id AND kind='main' AND workspace_id=NEW.workspace_id)
            BEGIN SELECT RAISE(ABORT, 'Side Thread must reference the main Thread in its workspace'); END;
          CREATE TRIGGER side_parent_update BEFORE UPDATE ON threads WHEN NEW.kind='side'
            AND NOT EXISTS (SELECT 1 FROM threads WHERE id=NEW.parent_thread_id AND kind='main' AND workspace_id=NEW.workspace_id)
            BEGIN SELECT RAISE(ABORT, 'Side Thread must reference the main Thread in its workspace'); END;
          CREATE TABLE runs (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
            thread_id TEXT NOT NULL REFERENCES threads(id), input_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('queued','running','cancelling','succeeded','failed','cancelled')),
            last_event_id INTEGER NOT NULL DEFAULT 0, error TEXT, error_code TEXT CHECK(error_code='interrupted'),
            retry_of_run_id TEXT REFERENCES runs(id));
          CREATE UNIQUE INDEX one_active_run ON runs(thread_id) WHERE status IN ('queued','running','cancelling');
          CREATE INDEX thread_runs ON runs(thread_id, ordinal);
          PRAGMA user_version=3;
        `);
      }).immediate();
      this.main = this.db.transaction(() => {
        this.db.query("INSERT OR IGNORE INTO workspaces VALUES (?, ?, ?)").run(crypto.randomUUID(), workspacePath, Date.now());
        const workspace = this.db.query<{ id: string; path: string; created_at: number }, [string]>("SELECT * FROM workspaces WHERE path=?").get(workspacePath)!;
        this.db.query("INSERT OR IGNORE INTO threads (id,workspace_id,kind,parent_thread_id,created_at) VALUES (?,?,'main',NULL,?)")
          .run(crypto.randomUUID(), workspace.id, Date.now());
        const thread = this.db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE workspace_id=? AND kind='main'").get(workspace.id)!;
        return { workspace: { id: workspace.id, path: workspace.path, createdAt: workspace.created_at },
          thread: { id: thread.id, workspaceId: workspace.id, kind: thread.kind, parentThreadId: thread.parent_thread_id, createdAt: thread.created_at },
          sessionId: thread.id };
      }).immediate();
      // Native messages already on disk remain canonical. Never replay an uncertain execution.
      this.db.query(`UPDATE runs SET status='failed',error_code='interrupted',last_event_id=MAX(last_event_id,1),
        error=? WHERE status IN ('queued','running','cancelling')`)
        .run("The server restarted before this reply completed. Unsaved streaming text was lost. Retry to start a new reply.");
    } catch (error) { this.db.close(); throw error; }
  }

  latest(threadId: string): RunRecord | undefined {
    const row = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE thread_id=? ORDER BY ordinal DESC LIMIT 1").get(threadId);
    return row ? record(row) : undefined;
  }
  run(threadId: string, runId: string): RunRecord | undefined {
    const row = this.db.query<RunRow, [string, string]>("SELECT * FROM runs WHERE thread_id=? AND id=?").get(threadId, runId);
    return row ? record(row) : undefined;
  }
  reserve(threadId: string, runId: string, message: string, retryOfRunId?: string): RunRecord {
    return this.db.transaction(() => {
      const inputHash = submissionHash(message);
      const previous = this.run(threadId, runId);
      if (previous) {
        if (previous.inputHash !== inputHash || previous.retryOfRunId !== retryOfRunId) throw new Error("This runId was already used for another submission.");
        return previous;
      }
      if (this.db.query("SELECT id FROM runs WHERE id=?").get(runId)) throw new Error("This runId belongs to another thread.");
      if (this.db.query("SELECT id FROM runs WHERE thread_id=? AND status IN ('queued','running','cancelling')").get(threadId)) throw new Error("This conversation is already responding.");
      if (retryOfRunId) {
        const source = this.run(threadId, retryOfRunId);
        if (!source || source.status !== "failed" || source.inputHash !== inputHash) throw new Error("Retry must refer to a failed reply in this conversation with the same message.");
      }
      this.db.query("INSERT INTO runs (id,thread_id,input_hash,created_at,status,retry_of_run_id) VALUES (?,?,?,?,'queued',?)")
        .run(runId, threadId, inputHash, Date.now(), retryOfRunId ?? null);
      return this.run(threadId, runId)!;
    }).immediate();
  }

  checkpoint(threadId: string, snapshot: RunSnapshot, runtimeState?: unknown): void {
    this.db.transaction(() => {
      const result = this.db.query("UPDATE runs SET status=?,last_event_id=?,error=?,error_code=? WHERE id=? AND thread_id=?")
        .run(snapshot.status, snapshot.lastEventId, snapshot.error ?? null, snapshot.errorCode ?? null, snapshot.id, threadId);
      if (!result.changes) throw new Error("Run not found.");
      if (runtimeState !== undefined) this.saveRuntime(threadId, runtimeState);
    }).immediate();
  }
  context(threadId: string): SessionContext {
    const thread = this.db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id=?").get(threadId);
    if (!thread) throw new Error("Thread not found.");
    const interruptedRunIds = this.db.query<{ id: string }, [string]>("SELECT id FROM runs WHERE thread_id=? AND error_code='interrupted' ORDER BY ordinal")
      .all(threadId).map((row) => row.id);
    return { threadId, ...(thread.runtime_json && { state: JSON.parse(thread.runtime_json) as unknown }), interruptedRunIds };
  }
  saveRuntime(threadId: string, state: unknown): void {
    if (!this.db.query("UPDATE threads SET runtime_json=? WHERE id=?").run(JSON.stringify(state), threadId).changes) throw new Error("Thread not found.");
  }
  close(): void { this.db.close(); }
}
