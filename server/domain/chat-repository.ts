import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MainConversation } from "../../shared/domain/chat";
import { isRunActive, isSessionId, type Message, type RunSnapshot, type StreamEvent } from "../../shared/chat";
import type { SessionContext } from "../runtime/types";
import { appendJsonLine, readJsonLines } from "./jsonl";

type RunRow = { id: string; thread_id: string; ordinal: number; status: string; log_file: string; last_event_id: number };
type ThreadRow = { id: string; workspace_id: string; kind: "main" | "side"; parent_thread_id: string | null;
  created_at: number; runtime_json: string | null; runtime_ordinal: number };
type RunLog = { snapshot: RunSnapshot; events: StreamEvent[] };
type RunHeader = { type: "run"; version: 1; threadId: string; snapshot: RunSnapshot };
type Checkpoint = { type: "checkpoint"; status: RunSnapshot["status"]; lastEventId: number; error?: string;
  errorCode?: RunSnapshot["errorCode"]; event?: StreamEvent; runtimeState?: unknown };

/** SQLite indexes identities/status; append-only JSONL is the source of message and event content. */
export class ChatRepository {
  readonly db: Database;
  readonly main: MainConversation;
  readonly logsDir: string;
  private readonly logs = new Map<string, RunLog>();

  constructor(databasePath: string, workspacePath: string) {
    this.logsDir = join(dirname(databasePath), "runs");
    mkdirSync(this.logsDir, { recursive: true });
    this.db = new Database(databasePath, { create: true, strict: true });
    try {
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version > 1) throw new Error("This Piko database requires a newer application version.");
      if (version === 0) this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
          CREATE TABLE threads (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
            kind TEXT NOT NULL CHECK(kind IN ('main','side')), parent_thread_id TEXT REFERENCES threads(id),
            created_at INTEGER NOT NULL, runtime_json TEXT, runtime_ordinal INTEGER NOT NULL DEFAULT 0,
            CHECK((kind='main' AND parent_thread_id IS NULL) OR (kind='side' AND parent_thread_id IS NOT NULL)));
          CREATE UNIQUE INDEX one_main_thread ON threads(workspace_id) WHERE kind='main';
          CREATE TRIGGER side_parent_insert BEFORE INSERT ON threads WHEN NEW.kind='side'
            AND NOT EXISTS (SELECT 1 FROM threads WHERE id=NEW.parent_thread_id AND kind='main' AND workspace_id=NEW.workspace_id)
            BEGIN SELECT RAISE(ABORT, 'Side Thread must reference the main Thread in its workspace'); END;
          CREATE TRIGGER side_parent_update BEFORE UPDATE ON threads WHEN NEW.kind='side'
            AND NOT EXISTS (SELECT 1 FROM threads WHERE id=NEW.parent_thread_id AND kind='main' AND workspace_id=NEW.workspace_id)
            BEGIN SELECT RAISE(ABORT, 'Side Thread must reference the main Thread in its workspace'); END;
          CREATE TABLE runs (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
            thread_id TEXT NOT NULL REFERENCES threads(id), status TEXT NOT NULL
              CHECK(status IN ('queued','running','cancelling','succeeded','failed','cancelled')),
            log_file TEXT NOT NULL UNIQUE, last_event_id INTEGER NOT NULL);
          CREATE UNIQUE INDEX one_active_run ON runs(thread_id) WHERE status IN ('queued','running','cancelling');
          CREATE INDEX thread_runs ON runs(thread_id, ordinal);
          PRAGMA user_version=1;
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
      this.reconcileLogs();
      this.recoverInterrupted();
    } catch (error) { this.db.close(); throw error; }
  }

  private path(runId: string): string {
    if (!isSessionId(runId)) throw new Error("Invalid Run identity.");
    return join(this.logsDir, `${runId}.jsonl`);
  }

  private readLog(runId: string): RunLog {
    const cached = this.logs.get(runId);
    if (cached) return cached;
    const path = this.path(runId);
    if (realpathSync(path) !== path) throw new Error("Run log must not be a symlink.");
    const records = readJsonLines(path);
    const header = records[0] as RunHeader | undefined;
    if (!header || header.type !== "run" || header.version !== 1 || header.snapshot.id !== runId || !isSessionId(header.threadId)
      || header.snapshot.status !== "queued" || header.snapshot.lastEventId !== 0 || header.snapshot.text !== ""
      || typeof header.snapshot.message !== "string" || !Number.isSafeInteger(header.snapshot.createdAt)) throw new Error(`Invalid Run log: ${path}`);
    const log: RunLog = { snapshot: { ...header.snapshot }, events: [] };
    for (const value of records.slice(1)) this.apply(log, value as Checkpoint);
    this.logs.set(runId, log);
    return log;
  }

  private apply(log: RunLog, record: Checkpoint): void {
    if (record.type !== "checkpoint" || !["queued","running","cancelling","succeeded","failed","cancelled"].includes(record.status)
      || record.lastEventId !== log.snapshot.lastEventId + (record.event ? 1 : 0)) throw new Error("Invalid Run checkpoint sequence.");
    if (record.event) {
      if (record.event.runId !== log.snapshot.id || record.event.sequence !== record.lastEventId
        || !["delta","done","error","cancelled"].includes(record.event.type)) throw new Error("Invalid Run event.");
      if (record.event.type === "delta") {
        if (typeof record.event.text !== "string") throw new Error("Invalid output delta.");
        log.snapshot.text += record.event.text;
      }
      log.events.push(record.event);
      if (log.events.length > 2048) log.events.shift();
    }
    Object.assign(log.snapshot, { status: record.status, lastEventId: record.lastEventId });
    if (record.error !== undefined) log.snapshot.error = record.error;
    if (record.errorCode !== undefined) log.snapshot.errorCode = record.errorCode;
  }

  /** A log may be ahead of SQLite after a crash; repair its metadata, never rerun the model. */
  private reconcileLogs(): void {
    const known = this.db.query<RunRow, []>("SELECT * FROM runs ORDER BY ordinal").all();
    for (const row of known) this.readLog(row.id); // Missing or corrupt indexed files fail closed.
    const knownNames = new Set(known.map((row) => row.log_file));
    const orphanNames = readdirSync(this.logsDir).filter((name) => name.endsWith(".jsonl") && !knownNames.has(name))
      .sort((a, b) => this.readLog(a.slice(0, -6)).snapshot.createdAt - this.readLog(b.slice(0, -6)).snapshot.createdAt || a.localeCompare(b));
    // First finish repairing indexed runs, freeing the active slot before adopting a new orphan header.
    for (const name of [...known.map((row) => row.log_file), ...orphanNames]) {
      const id = name.slice(0, -6);
      const log = this.readLog(id);
      const records = readJsonLines(this.path(id));
      const header = records[0] as RunHeader;
      const owner = this.db.query("SELECT id FROM threads WHERE id=?").get(header.threadId);
      if (!owner) throw new Error("Run log refers to an unknown Thread.");
      const row = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id=?").get(id);
      if (row && (row.thread_id !== header.threadId || row.log_file !== name || row.last_event_id > log.snapshot.lastEventId)) {
        throw new Error("Run index and JSONL file disagree. Restore a consistent backup.");
      }
      this.db.transaction(() => {
        if (!row) this.db.query("INSERT INTO runs (id,thread_id,status,log_file,last_event_id) VALUES (?,?,?,?,?)")
          .run(id, header.threadId, log.snapshot.status, name, log.snapshot.lastEventId);
        else this.db.query("UPDATE runs SET status=?,last_event_id=? WHERE id=?").run(log.snapshot.status, log.snapshot.lastEventId, id);
        const runtimeRecord = records.toReversed().find((record) => (record as Checkpoint).runtimeState !== undefined) as Checkpoint | undefined;
        if (runtimeRecord) {
          const thread = this.db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id=?").get(header.threadId)!;
          const ordinal = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id=?").get(id)!.ordinal;
          if (ordinal > thread.runtime_ordinal) this.saveRuntime(header.threadId, runtimeRecord.runtimeState, id);
        }
      }).immediate();
    }
  }

  private recoverInterrupted(): void {
    const active = this.db.query<RunRow, []>("SELECT * FROM runs WHERE status IN ('queued','running','cancelling') ORDER BY ordinal").all();
    for (const row of active) {
      const snapshot = { ...this.readLog(row.id).snapshot, status: "failed" as const, errorCode: "interrupted" as const,
        error: "The server restarted before this reply completed. Saved partial output is incomplete. Retry to start a new reply." };
      const event: StreamEvent = { type: "error", message: snapshot.error, runId: snapshot.id, sequence: ++snapshot.lastEventId };
      this.checkpoint(row.thread_id, snapshot, event);
    }
  }

  latest(threadId: string): RunSnapshot | undefined {
    const row = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE thread_id=? ORDER BY ordinal DESC LIMIT 1").get(threadId);
    return row ? { ...this.readLog(row.id).snapshot } : undefined;
  }
  run(threadId: string, runId: string): RunSnapshot | undefined {
    const row = this.db.query<RunRow, [string, string]>("SELECT * FROM runs WHERE thread_id=? AND id=?").get(threadId, runId);
    return row ? { ...this.readLog(row.id).snapshot } : undefined;
  }
  events(runId: string): StreamEvent[] { return [...this.readLog(runId).events]; }
  history(threadId: string): Message[] {
    return this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE thread_id=? ORDER BY ordinal").all(threadId).flatMap((row) => {
      const run = this.readLog(row.id).snapshot;
      const messages: Message[] = [{ id: `user-${run.id}`, role: "user", content: run.message, createdAt: run.createdAt }];
      if (!isRunActive(run) && run.text) messages.push({ id: `assistant-${run.id}`, role: "assistant", content: run.text, createdAt: run.createdAt });
      return messages;
    });
  }

  reserve(threadId: string, runId: string, message: string, retryOfRunId?: string): RunSnapshot {
    return this.db.transaction(() => {
      const previous = this.run(threadId, runId);
      if (previous) {
        if (previous.message !== message || previous.retryOfRunId !== retryOfRunId) throw new Error("This runId was already used for another submission.");
        return previous;
      }
      if (this.db.query("SELECT id FROM runs WHERE id=?").get(runId)) throw new Error("This runId belongs to another thread.");
      if (this.db.query("SELECT id FROM runs WHERE thread_id=? AND status IN ('queued','running','cancelling')").get(threadId)) throw new Error("This conversation is already responding.");
      if (retryOfRunId) {
        const source = this.run(threadId, retryOfRunId);
        if (!source || source.status !== "failed" || source.message !== message) throw new Error("Retry must refer to a failed reply in this conversation with the same message.");
      }
      const snapshot: RunSnapshot = { id: runId, message, text: "", status: "queued", createdAt: Date.now(), lastEventId: 0,
        ...(retryOfRunId && { retryOfRunId }) };
      appendJsonLine(this.path(runId), { type: "run", version: 1, threadId, snapshot } satisfies RunHeader, true);
      this.db.query("INSERT INTO runs (id,thread_id,status,log_file,last_event_id) VALUES (?,?,?, ?,0)").run(runId, threadId, snapshot.status, `${runId}.jsonl`);
      this.logs.set(runId, { snapshot: { ...snapshot }, events: [] });
      return snapshot;
    }).immediate();
  }

  checkpoint(threadId: string, snapshot: RunSnapshot, event?: StreamEvent, runtimeState?: unknown): void {
    const row = this.db.query<RunRow, [string, string]>("SELECT * FROM runs WHERE id=? AND thread_id=?").get(snapshot.id, threadId);
    if (!row) throw new Error("Run not found.");
    const record: Checkpoint = { type: "checkpoint", status: snapshot.status, lastEventId: snapshot.lastEventId,
      ...(snapshot.error && { error: snapshot.error }), ...(snapshot.errorCode && { errorCode: snapshot.errorCode }),
      ...(event && { event }), ...(runtimeState !== undefined && { runtimeState }) };
    const log = this.readLog(snapshot.id);
    // Validate before appending, then update the in-memory projection and SQL metadata.
    const next: RunLog = { snapshot: { ...log.snapshot }, events: [...log.events] };
    this.apply(next, record);
    if (next.snapshot.text !== snapshot.text) throw new Error("Output snapshot must match its durable event log.");
    appendJsonLine(this.path(snapshot.id), record);
    this.logs.set(snapshot.id, next);
    this.db.transaction(() => {
      this.db.query("UPDATE runs SET status=?,last_event_id=? WHERE id=?").run(snapshot.status, snapshot.lastEventId, snapshot.id);
      if (!isRunActive(snapshot) && runtimeState !== undefined) this.saveRuntime(threadId, runtimeState, snapshot.id);
    }).immediate();
  }

  context(threadId: string): SessionContext {
    const thread = this.db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id=?").get(threadId);
    if (!thread) throw new Error("Thread not found.");
    const recovery = this.db.query<RunRow, [string, number]>("SELECT * FROM runs WHERE thread_id=? AND ordinal>? AND status NOT IN ('queued','running','cancelling') ORDER BY ordinal")
      .all(threadId, thread.runtime_ordinal).map((row) => {
        const run = this.readLog(row.id).snapshot;
        return { runId: run.id, message: run.message, text: run.text, status: run.errorCode ?? run.status };
      });
    return { threadId, ...(thread.runtime_json && { state: JSON.parse(thread.runtime_json) as unknown }), recovery };
  }
  saveRuntime(threadId: string, state: unknown, throughRunId?: string): void {
    const ordinal = throughRunId ? this.db.query<RunRow, [string, string]>("SELECT * FROM runs WHERE id=? AND thread_id=?").get(throughRunId, threadId)?.ordinal : undefined;
    if (throughRunId && ordinal === undefined) throw new Error("Runtime checkpoint does not belong to this thread.");
    this.db.query("UPDATE threads SET runtime_json=?,runtime_ordinal=COALESCE(?,runtime_ordinal) WHERE id=?").run(JSON.stringify(state), ordinal ?? null, threadId);
  }
  close(): void { this.db.close(); }
}
