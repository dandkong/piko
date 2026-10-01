import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatRepository } from "../server/domain/chat-repository";
import { acquireBackendLock } from "../server/domain/backend-lock";
import { appendJsonLine, readJsonLines } from "../server/domain/jsonl";
import { initializeWorkspace, readGuidance, resolveWorkspacePaths } from "../server/domain/workspace";
import { ConversationStore } from "../server/chat/conversations";
import { ChatRun } from "../server/chat/run";
import { createApp } from "../server/app";
import { readServerConfig } from "../server/config";
import type { ChatSession, SessionContext } from "../server/runtime/types";
import type { StreamEvent } from "../shared/chat";

const roots: string[] = [];
const repositories: ChatRepository[] = [];
afterEach(() => {
  for (const repo of repositories.splice(0)) repo.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "piko-test-")); roots.push(root);
  const paths = initializeWorkspace(resolveWorkspacePaths({ PIKO_HOME: root }));
  const open = () => { const repo = new ChatRepository(paths.database, paths.workspace); repositories.push(repo); return repo; };
  const close = (repo: ChatRepository) => { repo.close(); repositories.splice(repositories.indexOf(repo), 1); };
  return { root, paths, open, close };
}
function finish(repo: ChatRepository, id: string, text = "reply", state?: unknown) {
  const snapshot = repo.run(repo.main.sessionId, id)!;
  repo.checkpoint(repo.main.sessionId, { ...snapshot, status: "running", text, lastEventId: 1 },
    { type: "delta", text, runId: id, sequence: 1 });
  repo.checkpoint(repo.main.sessionId, { ...snapshot, status: "succeeded", text, lastEventId: 2 },
    { type: "done", runId: id, sequence: 2 }, state);
}

describe("workspace and JSONL index", () => {
  test("initialization is idempotent, preserves user guidance, bounds reads, and rejects conflicting types", () => {
    const f = fixture();
    writeFileSync(join(f.paths.workspace, "USER.md"), "mine".repeat(100));
    initializeWorkspace(f.paths);
    expect(readFileSync(join(f.paths.workspace, "USER.md"), "utf8")).toBe("mine".repeat(100));
    expect(readGuidance(f.paths.workspace, "USER.md", 4)).toStartWith("mine\n[Guidance truncated");
    expect(existsSync(join(f.paths.workspace, ".agents/skills"))).toBe(true);
    expect(() => resolveWorkspacePaths({ PIKO_HOME: "relative" })).toThrow("absolute");
    expect(() => initializeWorkspace({ ...f.paths, state: join(f.paths.workspace, "state") })).toThrow("outside");
    rmSync(join(f.paths.workspace, "USER.md")); mkdirSync(join(f.paths.workspace, "USER.md"));
    expect(() => initializeWorkspace(f.paths)).toThrow("regular file");
  });

  test("a live backend lock excludes another writer and a stale lock is recoverable", () => {
    const f = fixture(); const release = acquireBackendLock(f.paths.state);
    expect(() => acquireBackendLock(f.paths.state)).toThrow("already owned");
    release();
    writeFileSync(join(f.paths.state, "backend.lock"), JSON.stringify({ pid: 2147483647, token: "old" }));
    const recovered = acquireBackendLock(f.paths.state); recovered();
    expect(existsSync(join(f.paths.state, "backend.lock"))).toBe(false);
  });

  test("one stable main Thread, derived message identities, and past Run deduplication survive restart", () => {
    const f = fixture(); const repo = f.open(); const main = repo.main;
    const first = crypto.randomUUID(), second = crypto.randomUUID();
    repo.reserve(main.sessionId, first, "first input"); finish(repo, first, "first reply", { marker: 1 });
    repo.reserve(main.sessionId, second, "second input"); finish(repo, second, "second reply", { marker: 2 });
    const history = repo.history(main.sessionId);
    expect(history.map((message) => message.content)).toEqual(["first input", "first reply", "second input", "second reply"]);
    f.close(repo); const resumed = f.open();
    expect(resumed.main).toEqual(main);
    expect(resumed.history(main.sessionId)).toEqual(history);
    expect(resumed.reserve(main.sessionId, first, "first input").status).toBe("succeeded");
    expect(() => resumed.reserve(main.sessionId, first, "changed")).toThrow("already used");
    expect(resumed.context(main.sessionId).state).toEqual({ marker: 2 });
    expect(resumed.db.query("PRAGMA table_info(runs)").all().map((row: any) => row.name)).toEqual([
      "ordinal", "id", "thread_id", "status", "log_file", "last_event_id",
    ]);
    expect(() => resumed.db.query("INSERT INTO threads (id,workspace_id,kind,created_at) VALUES (?,?,'main',0)")
      .run(crypto.randomUUID(), main.workspace.id)).toThrow();
    expect(() => resumed.db.query("INSERT INTO threads (id,workspace_id,kind,created_at) VALUES (?,?,'side',0)")
      .run(crypto.randomUUID(), main.workspace.id)).toThrow();
    const side = crypto.randomUUID();
    resumed.db.query("INSERT INTO threads (id,workspace_id,kind,parent_thread_id,created_at) VALUES (?,?,'side',?,0)")
      .run(side, main.workspace.id, main.thread.id);
    expect(() => resumed.db.query("INSERT INTO threads (id,workspace_id,kind,parent_thread_id,created_at) VALUES (?,?,'side',?,0)")
      .run(crypto.randomUUID(), main.workspace.id, side)).toThrow("main Thread");
  });

  test("an interrupted Run preserves partial output and events; retry is an explicitly related new Run", () => {
    const f = fixture(); const repo = f.open(); const id = crypto.randomUUID(), thread = repo.main.sessionId;
    const run = repo.reserve(thread, id, "work");
    expect(() => repo.reserve(thread, crypto.randomUUID(), "other")).toThrow("already responding");
    repo.checkpoint(thread, { ...run, status: "running", text: "partial", lastEventId: 1 },
      { type: "delta", text: "partial", runId: id, sequence: 1 });
    f.close(repo); const resumed = f.open();
    expect(resumed.latest(thread)).toMatchObject({ status: "failed", errorCode: "interrupted", text: "partial", lastEventId: 2 });
    expect(resumed.history(thread).map((message) => message.content)).toEqual(["work", "partial"]);
    expect(resumed.events(id).map((event) => event.type)).toEqual(["delta", "error"]);
    expect(resumed.context(thread).recovery).toEqual([{ runId: id, message: "work", text: "partial", status: "interrupted" }]);
    expect(() => resumed.reserve(thread, crypto.randomUUID(), "changed", id)).toThrow("same message");
    const retry = resumed.reserve(thread, crypto.randomUUID(), "work", id);
    expect(retry.retryOfRunId).toBe(id);
  });

  test("logs ahead of SQLite and an orphan submission are reconciled in execution order", () => {
    const f = fixture(); const repo = f.open(); const thread = repo.main.sessionId;
    const first = "ffffffff-ffff-4fff-8fff-ffffffffffff", orphan = "00000000-0000-4000-8000-000000000001";
    repo.reserve(thread, first, "old");
    appendJsonLine(join(repo.logsDir, `${first}.jsonl`), { type: "checkpoint", status: "succeeded", lastEventId: 1,
      event: { type: "done", runId: first, sequence: 1 }, runtimeState: { marker: "committed" } });
    appendJsonLine(join(repo.logsDir, `${orphan}.jsonl`), { type: "run", version: 1, threadId: thread,
      snapshot: { id: orphan, status: "queued", message: "new", text: "", createdAt: Date.now() + 1, lastEventId: 0 } }, true);
    f.close(repo); const resumed = f.open();
    expect(resumed.run(thread, first)?.status).toBe("succeeded");
    expect(resumed.latest(thread)).toMatchObject({ id: orphan, errorCode: "interrupted" });
    expect(resumed.context(thread).state).toEqual({ marker: "committed" });
    expect(resumed.context(thread).recovery.map((run) => run.runId)).toEqual([orphan]);
  });

  test("a subsequently saved context pointer is not overwritten by an older terminal log on restart", () => {
    const f = fixture(); const repo = f.open(); const thread = repo.main.sessionId, id = crypto.randomUUID();
    repo.reserve(thread, id, "input"); finish(repo, id, "out", { leaf: "old" });
    repo.saveRuntime(thread, { leaf: "new baseline" }, id);
    f.close(repo); expect(f.open().context(thread).state).toEqual({ leaf: "new baseline" });
  });

  test("torn final appends are archived; interior corruption, missing files and newer schema fail closed", () => {
    const f = fixture(); const file = join(f.root, "records.jsonl");
    appendJsonLine(file, { ok: 1 }, true); appendFileSync(file, '{"partial":');
    expect(readJsonLines(file)).toEqual([{ ok: 1 }]);
    expect(readdirSync(f.root).some((name) => name.startsWith("records.jsonl.torn-"))).toBe(true);
    appendJsonLine(file, { ok: 2 }); expect(readJsonLines(file)).toHaveLength(2);
    writeFileSync(file, '{bad}\n{"ok":1}\n'); expect(() => readJsonLines(file)).toThrow("Corrupt JSONL");
    const repo = f.open(); const id = crypto.randomUUID(); repo.reserve(repo.main.sessionId, id, "x");
    rmSync(join(repo.logsDir, `${id}.jsonl`)); f.close(repo);
    expect(() => f.open()).toThrow();
    // No future-version database is silently overwritten.
    const other = fixture(), future = other.open(); future.db.exec("PRAGMA user_version=2"); other.close(future);
    expect(() => other.open()).toThrow("newer application");
  });
});

class FakeSession implements ChatSession {
  isStreaming = false;
  messages = [];
  promptCalls = 0;
  private listeners = new Set<(event: StreamEvent) => void>();
  subscribe(listener: (event: StreamEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async prompt() { this.promptCalls++; this.isStreaming = true; for (const listener of this.listeners) listener({ type: "delta", text: "saved" }); this.isStreaming = false; }
  async abort() { this.isStreaming = false; }
  dispose() { }
  exportState() { return { mockCheckpoint: this.promptCalls }; }
}

test("main discovery across clients, persistent SSE replay and duplicate requests do not reexecute the model", async () => {
  const f = fixture(); const repo = f.open(); const config = readServerConfig({}); const session = new FakeSession();
  const contexts: (SessionContext | undefined)[] = [];
  const runtime = { isModelReady: async () => true, createSession: async (context?: SessionContext) => { contexts.push(context); return session; } };
  const store = new ConversationStore(runtime.createSession, config, repo);
  const app = createApp({ config, runtime, conversations: store });
  const client = () => app(new Request("http://local/api/main")).then((response) => response.json());
  expect(await client()).toEqual(await client()); expect(session.promptCalls).toBe(0);
  expect((await app(new Request(`http://local/api/sessions/${crypto.randomUUID()}`))).status).toBe(409);
  expect((await app(new Request(`http://local/api/sessions/${repo.main.sessionId}`, { method: "DELETE" }))).status).toBe(409);
  const request = (id: string) => new Request("http://local/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: repo.main.sessionId, runId: id, message: "hi" }) });
  const id = crypto.randomUUID();
  const [a, b] = await Promise.all([app(request(id)), app(request(id))]);
  const [first, duplicate] = await Promise.all([a.text(), b.text()]);
  expect(first).toContain('"text":"saved"'); expect(duplicate).toContain('"type":"done"');
  expect(session.promptCalls).toBe(1); expect(contexts).toHaveLength(1);
  store.dispose(); f.close(repo);
  const resumed = f.open(); const resumedStore = new ConversationStore(runtime.createSession, config, resumed);
  const resumedApp = createApp({ config, runtime, conversations: resumedStore });
  expect(await (await resumedApp(request(id))).text()).toContain('"type":"done"');
  expect(session.promptCalls).toBe(1);
  const snapshot = await (await resumedApp(new Request(`http://local/api/sessions/${resumed.main.sessionId}`))).json();
  expect(snapshot.messages.map((message: any) => message.content)).toEqual(["hi", "saved"]);
  expect(contexts).toHaveLength(1); resumedStore.dispose();
});

test("a failed durable write never publishes output or a successful terminal event", async () => {
  const session = new FakeSession(); const events: StreamEvent[] = [];
  let writes = 0;
  const id = crypto.randomUUID();
  const run = new ChatRun(id, "input", [], {
    snapshot: { id, message: "input", text: "", status: "queued", createdAt: 1, lastEventId: 0 }, events: [],
    checkpoint: (snapshot, event) => { writes++; if (event) throw new Error("disk full"); expect(snapshot.status).toBe("running"); },
  });
  run.subscribe(0, (event) => events.push(event));
  await expect(run.execute(async () => ({ session, touchedAt: 1 }))).rejects.toThrow("disk full");
  expect(events).toEqual([]);
  expect(run.snapshot).toMatchObject({ status: "running", text: "", lastEventId: 0 });
  expect(writes).toBe(2); // No second append to a potentially torn record.
});
