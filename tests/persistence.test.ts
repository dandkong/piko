import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fixture, repository, waitUntil } from "./fixtures/durable";
import { initializeWorkspace, readGuidance, resolveWorkspacePaths } from "../server/domain/workspace";
import { acquireBackendLock } from "../server/domain/backend-lock";
import { ConversationStore } from "../server/chat/conversations";
import { ChatRun } from "../server/chat/run";
import { createApp } from "../server/app";
import { readServerConfig } from "../server/config";
import type { RunSnapshot, StreamEvent } from "../shared/chat";
import { readPiEntries } from "../server/runtime/pi-history";
import { DurableChatSession } from "../server/runtime/pi";

test("initialization preserves guidance and JSON configuration, bounds reads and rejects conflicting paths", async () => {
  const f = await fixture();
  await writeFile(join(f.paths.workspace, "USER.md"), "mine".repeat(100));
  await writeFile(join(f.paths.home, "config/auth.json"), '{"test":{"type":"api_key","key":"private"}}');
  initializeWorkspace(f.paths);
  expect(await readFile(join(f.paths.workspace, "USER.md"), "utf8")).toBe("mine".repeat(100));
  expect(await readFile(join(f.paths.home, "config/auth.json"), "utf8")).toContain("private");
  expect(readGuidance(f.paths.workspace, "USER.md", 4)).toStartWith("mine\n[Guidance truncated");
  expect(existsSync(join(f.paths.workspace, ".agents/skills"))).toBe(true);
  expect(() => resolveWorkspacePaths({ PIKO_HOME: "relative" })).toThrow("absolute");
  expect(() => initializeWorkspace({ ...f.paths, state: join(f.paths.workspace, "state") })).toThrow("outside");
});

test("a live backend lock excludes another writer and stale lock ownership is recoverable", async () => {
  const f = await fixture(); const release = acquireBackendLock(f.paths.state);
  expect(() => acquireBackendLock(f.paths.state)).toThrow("already owned");
  release();
  await writeFile(join(f.paths.state, "backend.lock"), JSON.stringify({ pid: 2147483647, token: "old" }));
  acquireBackendLock(f.paths.state)();
  expect(existsSync(join(f.paths.state, "backend.lock"))).toBe(false);
});

test("stable main identity, hashed deduplication, retry and side relations persist without storing bodies in SQLite", async () => {
  const f = await fixture(); const repo = repository(f.paths); const main = repo.main;
  const id = crypto.randomUUID(); const meta = repo.reserve(main.sessionId, id, "input");
  repo.checkpoint(main.sessionId, { ...meta, message: "input", text: "reply", status: "failed", lastEventId: 2 });
  expect(repo.reserve(main.sessionId, id, "input").status).toBe("failed");
  expect(() => repo.reserve(main.sessionId, id, "changed")).toThrow("already used");
  const retry = crypto.randomUUID(); expect(repo.reserve(main.sessionId, retry, "input", id).retryOfRunId).toBe(id);
  const columns = repo.db.query<{ name: string }, []>("PRAGMA table_info(runs)").all().map(row => row.name);
  expect(columns).toEqual(["ordinal", "id", "thread_id", "input_hash", "created_at", "status", "last_event_id", "error", "error_code", "retry_of_run_id"]);
  expect(() => repo.db.query("INSERT INTO threads (id,workspace_id,kind,created_at) VALUES (?,?,'main',0)")
    .run(crypto.randomUUID(), main.workspace.id)).toThrow();
  const side = crypto.randomUUID();
  repo.db.query("INSERT INTO threads (id,workspace_id,kind,parent_thread_id,created_at) VALUES (?,?,'side',?,0)")
    .run(side, main.workspace.id, main.thread.id);
  expect(() => repo.db.query("INSERT INTO threads (id,workspace_id,kind,parent_thread_id,created_at) VALUES (?,?,'side',?,0)")
    .run(crypto.randomUUID(), main.workspace.id, side)).toThrow("main Thread");
  repo.close(); const restart = repository(f.paths);
  expect(restart.main).toEqual(main);
  expect(restart.latest(main.sessionId)).toMatchObject({ id: retry, status: "failed", errorCode: "interrupted" });
});

test("restart retains native messages, aborts uncertain work before scheduling, and records one hidden interruption notice", async () => {
  const f = await fixture(30); const repo = repository(f.paths); const id = crypto.randomUUID(); const thread = repo.main.sessionId;
  const meta = repo.reserve(thread, id, "work");
  const session = await f.runtime.createSession(repo.context(thread)) as DurableChatSession;
  repo.saveRuntime(thread, session.exportState());
  repo.checkpoint(thread, { ...meta, message: "work", text: "", status: "running" });
  f.faux.setResponses([fauxAssistantMessage("A very long answer that will still be running when the process closes.")]);
  const pending = session.prompt("work", { id, createdAt: 1 }).catch(() => {});
  await waitUntil(() => f.faux.state.callCount > 0); await Bun.sleep(80);
  await f.runtime.dispose!(); await pending; repo.close();
  const resumed = repository(f.paths); const runtime = f.createRuntime();
  expect(resumed.latest(thread)).toMatchObject({ status: "failed", errorCode: "interrupted" });
  expect((await runtime.readHistory(resumed.context(thread))).messages[0]?.content).toBe("work");
  const reopened = await runtime.createSession(resumed.context(thread)) as DurableChatSession;
  expect(f.faux.state.callCount).toBe(1);
  expect((await readPiEntries(reopened.nativeHarness)).filter(entry => entry.kind === "piko.interrupted")).toHaveLength(1);
  await reopened.dispose();
  const again = await runtime.createSession(resumed.context(thread)) as DurableChatSession;
  expect((await readPiEntries(again.nativeHarness)).filter(entry => entry.kind === "piko.interrupted")).toHaveLength(1);
  expect(f.faux.state.callCount).toBe(1);
});

test("a submission interrupted before native admission has no invented body and remains deduplicated", async () => {
  const f = await fixture(); const repo = repository(f.paths); const thread = repo.main.sessionId, id = crypto.randomUUID();
  repo.reserve(thread, id, "accepted but not started"); repo.close();
  const resumed = repository(f.paths);
  const store = new ConversationStore(f.runtime.createSession, readServerConfig({}), resumed, f.runtime.readHistory);
  expect(await store.history(thread)).toEqual([]);
  expect((await store.run(thread))?.snapshot).toMatchObject({ message: "", text: "", errorCode: "interrupted" });
  expect((await store.startRun(thread, id, "accepted but not started")).snapshot.status).toBe("failed");
  await expect(store.startRun(thread, id, "different")).rejects.toThrow("already used");
  expect(f.faux.state.callCount).toBe(0); await store.dispose();
});

test("main API, native history, SSE replay and duplicate requests never reexecute the model", async () => {
  const f = await fixture(); const repo = repository(f.paths); const config = readServerConfig({});
  const store = new ConversationStore(f.runtime.createSession, config, repo, f.runtime.readHistory);
  const app = createApp({ config, runtime: f.runtime, conversations: store });
  const discovery = () => app(new Request("http://local/api/main")).then(response => response.json());
  expect(await discovery()).toEqual(await discovery());
  expect((await app(new Request("http://local/api/sessions/" + crypto.randomUUID()))).status).toBe(409);
  f.faux.setResponses([fauxAssistantMessage("saved")]);
  const id = crypto.randomUUID();
  const request = () => new Request("http://local/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: repo.main.sessionId, runId: id, message: "hi" }) });
  const [a, b] = await Promise.all([app(request()), app(request())]);
  const [first, duplicate] = await Promise.all([a.text(), b.text()]);
  expect(first).toContain('"text":"saved"'); expect(duplicate).toContain('"type":"done"');
  expect(f.faux.state.callCount).toBe(1);
  const before = await store.history(repo.main.sessionId);
  expect(before.map(message => message.content)).toEqual(["hi", "saved"]);
  await store.dispose(); repo.close();
  const resumed = repository(f.paths); const restartRuntime = f.createRuntime();
  const restartStore = new ConversationStore(restartRuntime.createSession, config, resumed, restartRuntime.readHistory);
  const restartApp = createApp({ config, runtime: restartRuntime, conversations: restartStore });
  expect((await restartApp(request())).status).toBe(409);
  const snapshot = await (await restartApp(new Request("http://local/api/sessions/" + resumed.main.sessionId))).json();
  expect(snapshot.messages).toEqual(before);
  expect(snapshot.run).toMatchObject({ message: "hi", text: "saved", status: "succeeded" });
  expect(f.faux.state.callCount).toBe(1); await restartStore.dispose();
});

test("stream deltas remain transient and a failed terminal flush cannot publish success", async () => {
  const f = await fixture(); const session = await f.createSession();
  f.faux.setResponses([fauxAssistantMessage("saved")]);
  const events: StreamEvent[] = [], writes: RunSnapshot[] = [];
  const run = new ChatRun({ id: crypto.randomUUID(), message: "input", text: "", status: "queued", createdAt: 1, lastEventId: 0 },
    snapshot => { writes.push(snapshot); if (snapshot.status === "succeeded") throw new Error("disk full"); });
  run.subscribe(0, event => events.push(event));
  await expect(run.execute(async () => ({ session, touchedAt: 1 }))).rejects.toThrow("disk full");
  expect(events.map(event => event.type)).toEqual(["delta"]);
  expect(run.snapshot).toMatchObject({ status: "running", text: "saved", lastEventId: 1 });
  expect(writes.map(snapshot => snapshot.status)).toEqual(["running", "succeeded"]);
});

test("old development schemas fail closed without deleting user data", async () => {
  const f = await fixture(); const repo = repository(f.paths); repo.db.exec("PRAGMA user_version=2"); repo.close();
  expect(() => repository(f.paths)).toThrow("Incompatible development database");
  expect(existsSync(f.paths.database)).toBe(true);
});
