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
import { openPiContext, readPiContext, exportPiReference } from "../server/runtime/pi-context";
import { projectPiHistory } from "../server/runtime/pi-history";
import type { ChatSession, HistoryReader, SessionContext } from "../server/runtime/types";
import type { Message, RunSnapshot, StreamEvent } from "../shared/chat";
import { assistant } from "./fixtures/pi-message";

const roots: string[] = [];
const repositories: ChatRepository[] = [];
afterEach(() => {
  for (const repo of repositories.splice(0)) repo.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "piko-test-")); roots.push(root);
  const paths = initializeWorkspace(resolveWorkspacePaths({ PIKO_HOME: root }));
  const directory = join(paths.state, "pi-sessions");
  const open = () => { const repo = new ChatRepository(paths.database, paths.workspace); repositories.push(repo); return repo; };
  const close = (repo: ChatRepository) => { repo.close(); repositories.splice(repositories.indexOf(repo), 1); };
  const readHistory: HistoryReader = (context) => projectPiHistory(readPiContext(paths.workspace, directory, context)?.getBranch() ?? []);
  return { root, paths, directory, open, close, readHistory };
}
function finish(repo: ChatRepository, id: string, message: string, text = "reply", state?: unknown) {
  const record = repo.run(repo.main.sessionId, id)!;
  repo.checkpoint(repo.main.sessionId, { ...record, message, text, status: "succeeded", lastEventId: 2 }, state);
}

describe("workspace and metadata", () => {
  test("initialization preserves user guidance, bounds reads, and rejects conflicting types", () => {
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

  test("stable main Thread, hashed deduplication, retry identity and side relation survive restart without body storage", () => {
    const f = fixture(); const repo = f.open(); const main = repo.main;
    const first = crypto.randomUUID(), second = crypto.randomUUID();
    repo.reserve(main.sessionId, first, "first input"); finish(repo, first, "first input", "first reply", { marker: 1 });
    repo.reserve(main.sessionId, second, "second input"); finish(repo, second, "second input", "second reply", { marker: 2 });
    f.close(repo); const resumed = f.open();
    expect(resumed.main).toEqual(main);
    expect(resumed.reserve(main.sessionId, first, "first input").status).toBe("succeeded");
    expect(() => resumed.reserve(main.sessionId, first, "changed")).toThrow("already used");
    expect(() => resumed.reserve(main.sessionId, first, "first input", second)).toThrow("already used");
    expect(resumed.context(main.sessionId).state).toEqual({ marker: 2 });
    const columns = resumed.db.query<{ name: string }, []>("PRAGMA table_info(runs)").all().map((row) => row.name);
    expect(columns).toEqual(["ordinal", "id", "thread_id", "input_hash", "created_at", "status", "last_event_id", "error", "error_code", "retry_of_run_id"]);
    expect(existsSync(join(f.paths.state, "runs"))).toBe(false);
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

  test("restart fails an uncertain execution; output is recovered only from Pi and an explicit retry is a new Run", () => {
    const f = fixture(); const repo = f.open(); const id = crypto.randomUUID(), thread = repo.main.sessionId;
    const meta = repo.reserve(thread, id, "work");
    expect(() => repo.reserve(thread, crypto.randomUUID(), "other")).toThrow("already responding");
    const native = openPiContext(f.paths.workspace, f.directory, repo.context(thread));
    repo.saveRuntime(thread, exportPiReference(native));
    native.appendCustomEntry("piko-run", { runId: id });
    native.appendMessage({ role: "user", content: "work", timestamp: 1 });
    native.appendMessage(assistant("saved before the crash"));
    repo.checkpoint(thread, { ...meta, message: "work", text: "unsaved delta", status: "running", lastEventId: 0 });
    f.close(repo); const resumed = f.open();
    expect(resumed.latest(thread)).toMatchObject({ status: "failed", errorCode: "interrupted", lastEventId: 1 });
    expect(resumed.context(thread).interruptedRunIds).toEqual([id]);
    const store = new ConversationStore(async () => { throw new Error("Must not execute"); }, readServerConfig({}), resumed, f.readHistory);
    expect(store.history(thread).map((message) => message.content)).toEqual(["work", "saved before the crash"]);
    expect(store.run(thread)?.snapshot.text).toBe("saved before the crash");
    expect(store.run(thread)?.canReplay(0)).toBe(false);
    expect(() => resumed.reserve(thread, crypto.randomUUID(), "changed", id)).toThrow("same message");
    expect(resumed.reserve(thread, crypto.randomUUID(), "work", id).retryOfRunId).toBe(id);
    store.dispose();
  });

  test("a request interrupted before Pi's user message has no invented history and remains deduplicated", () => {
    const f = fixture(); const repo = f.open(); const thread = repo.main.sessionId, id = crypto.randomUUID();
    repo.reserve(thread, id, "accepted but not started");
    f.close(repo); const resumed = f.open();
    const store = new ConversationStore(async () => { throw new Error("Must not execute"); }, readServerConfig({}), resumed, f.readHistory);
    expect(store.history(thread)).toEqual([]);
    expect(store.run(thread)?.snapshot).toMatchObject({ message: "", text: "", errorCode: "interrupted" });
    expect(store.startRun(thread, id, "accepted but not started").snapshot.status).toBe("failed");
    expect(() => store.startRun(thread, id, "different")).toThrow("already used");
    store.dispose();
  });

  test("native JSONL torn tails are archived, interior corruption and unsupported schemas fail closed", () => {
    const f = fixture(); const file = join(f.root, "records.jsonl");
    appendJsonLine(file, { ok: 1 }, true); appendFileSync(file, '{"partial":');
    expect(readJsonLines(file)).toEqual([{ ok: 1 }]);
    expect(readdirSync(f.root).some((name) => name.startsWith("records.jsonl.torn-"))).toBe(true);
    appendJsonLine(file, { ok: 2 }); expect(readJsonLines(file)).toHaveLength(2);
    writeFileSync(file, '{bad}\n{"ok":1}\n'); expect(() => readJsonLines(file)).toThrow("Corrupt JSONL");
    for (const version of [1, 3]) {
      const other = fixture(), unsupported = other.open(); unsupported.db.exec("PRAGMA user_version=" + version); other.close(unsupported);
      expect(() => other.open()).toThrow("Incompatible development database");
    }
  });
});

class FakeSession implements ChatSession {
  isStreaming = false;
  promptCalls = 0;
  private listeners = new Set<(event: StreamEvent) => void>();
  constructor(readonly manager: ReturnType<typeof openPiContext>) {}
  get messages(): Message[] { return projectPiHistory(this.manager.getBranch()).messages; }
  subscribe(listener: (event: StreamEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async prompt(text: string, run?: { id: string }) {
    this.promptCalls++; this.isStreaming = true;
    this.manager.appendCustomEntry("piko-run", { runId: run!.id });
    this.manager.appendMessage({ role: "user", content: text, timestamp: 1 });
    for (const listener of this.listeners) listener({ type: "delta", text: "saved" });
    this.manager.appendMessage(assistant("saved"));
    this.isStreaming = false;
  }
  async abort() { this.isStreaming = false; }
  dispose() {}
  exportState() { return exportPiReference(this.manager); }
}

test("main discovery, native history, live SSE replay, and durable duplicate requests never reexecute the model", async () => {
  const f = fixture(); const repo = f.open(); const config = readServerConfig({});
  let session: FakeSession | undefined; let creations = 0;
  const runtime = { isModelReady: async () => true, readHistory: f.readHistory,
    createSession: async (context?: SessionContext) => {
      creations++; session = new FakeSession(openPiContext(f.paths.workspace, f.directory, context!)); return session;
    } };
  const store = new ConversationStore(runtime.createSession, config, repo, runtime.readHistory);
  const app = createApp({ config, runtime, conversations: store });
  const client = () => app(new Request("http://local/api/main")).then((response) => response.json());
  expect(await client()).toEqual(await client()); expect(creations).toBe(0);
  expect((await app(new Request("http://local/api/sessions/" + crypto.randomUUID()))).status).toBe(409);
  expect((await app(new Request("http://local/api/sessions/" + repo.main.sessionId, { method: "DELETE" }))).status).toBe(409);
  const id = crypto.randomUUID();
  const request = () => new Request("http://local/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: repo.main.sessionId, runId: id, message: "hi" }) });
  const [a, b] = await Promise.all([app(request()), app(request())]);
  const [first, duplicate] = await Promise.all([a.text(), b.text()]);
  expect(first).toContain('"text":"saved"'); expect(duplicate).toContain('"type":"done"');
  expect(session!.promptCalls).toBe(1); expect(creations).toBe(1);
  const before = store.history(repo.main.sessionId);
  expect(before.map((message) => message.content)).toEqual(["hi", "saved"]);
  store.dispose(); f.close(repo);
  const resumed = f.open(); const resumedStore = new ConversationStore(runtime.createSession, config, resumed, runtime.readHistory);
  const resumedApp = createApp({ config, runtime, conversations: resumedStore });
  expect((await resumedApp(request())).status).toBe(409); // Replay expired; load the native snapshot.
  expect(session!.promptCalls).toBe(1);
  const snapshot = await (await resumedApp(new Request("http://local/api/sessions/" + resumed.main.sessionId))).json();
  expect(snapshot.messages).toEqual(before);
  expect(snapshot.run).toMatchObject({ message: "hi", text: "saved", status: "succeeded" });
  expect(creations).toBe(1); resumedStore.dispose();
});

test("stream deltas do not write storage; a failed terminal flush cannot publish success", async () => {
  const f = fixture(); const session = new FakeSession(openPiContext(f.paths.workspace, f.directory,
    { threadId: crypto.randomUUID(), interruptedRunIds: [] }));
  const events: StreamEvent[] = []; const writes: RunSnapshot[] = [];
  const id = crypto.randomUUID();
  const run = new ChatRun({ id, message: "input", text: "", status: "queued", createdAt: 1, lastEventId: 0 },
    (snapshot) => { writes.push(snapshot); if (snapshot.status === "succeeded") throw new Error("disk full"); });
  run.subscribe(0, (event) => events.push(event));
  await expect(run.execute(async () => ({ session, touchedAt: 1 }))).rejects.toThrow("disk full");
  expect(events.map((event) => event.type)).toEqual(["delta"]);
  expect(run.snapshot).toMatchObject({ status: "running", text: "saved", lastEventId: 1 });
  expect(writes.map((snapshot) => snapshot.status)).toEqual(["running", "succeeded"]);
});
