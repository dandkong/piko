import { afterEach, describe, expect, test } from "bun:test";
import type { Message, StreamEvent } from "../shared/chat";
import { consumeSse } from "../shared/sse";
import { createApp } from "../server/app";
import { ConversationStore } from "../server/chat/conversations";
import { chatStream } from "../server/chat/stream";
import { readServerConfig } from "../server/config";
import type { ChatRuntime, ChatSession, HistoryReader } from "../server/runtime/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatRepository } from "../server/domain/chat-repository";

let sessionId = "b9b7c60a-b2e2-4af0-8a61-fb0903629aca";
const runId = "7a5c9c78-030a-4c2a-b6f7-13974210b807";

class TestSession implements ChatSession {
  isStreaming = false;
  messages: Message[] = [];
  abortCalls = 0;
  promptCalls = 0;
  disposed = false;
  readonly started = Promise.withResolvers<void>();
  private readonly finished = Promise.withResolvers<void>();
  private readonly listeners = new Set<(event: StreamEvent) => void>();

  constructor(private readonly hold = false) { }

  subscribe(listener: (event: StreamEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async prompt(text: string, run?: { id: string }) {
    this.promptCalls++;
    this.isStreaming = true;
    this.started.resolve();
    this.messages.push({ id: "user-" + this.promptCalls, role: "user", content: text, createdAt: 1, runId: run?.id });
    for (const listener of this.listeners) listener({ type: "delta", text: "Hello" });
    if (this.hold) await this.finished.promise;
    this.isStreaming = false;
    this.messages.push({ id: "assistant-" + this.promptCalls, role: "assistant", content: "Hello", createdAt: 2, runId: run?.id });
  }

  async abort() {
    this.abortCalls++;
    this.isStreaming = false;
    this.finished.resolve();
  }

  dispose() { this.disposed = true; }
  emit(event: StreamEvent) { for (const listener of this.listeners) listener(event); }
}


const fixtures: { root: string; repo: ChatRepository }[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) { fixture.repo.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});
function storage(session?: TestSession) {
  const root = mkdtempSync(join(tmpdir(), "piko-api-test-"));
  const repo = new ChatRepository(join(root, "piko.sqlite"), root);
  fixtures.push({ root, repo }); sessionId = repo.main.sessionId;
  const readHistory: HistoryReader = () => {
    const messages = session?.messages ?? [];
    const runs = new Map<string, { message: string; text: string }>();
    for (const message of messages) {
      if (!message.runId) continue;
      const run = runs.get(message.runId) ?? { message: "", text: "" };
      if (message.role === "user") run.message = message.content;
      else run.text += message.content;
      runs.set(message.runId, run);
    }
    return { messages, runs };
  };
  return { repo, readHistory };
}

function setup(session = new TestSession()) {
  const { repo, readHistory } = storage(session);
  let creations = 0;
  const config = readServerConfig({});
  const runtime: ChatRuntime = {
    readHistory,
    isModelReady: async () => true,
    createSession: async () => { creations++; return session; },
  };
  const conversations = new ConversationStore(runtime.createSession, config, repo, readHistory);
  const app = createApp({ config, runtime, conversations });
  return { app, conversations, session, repo, readHistory, get creations() { return creations; } };
}

function chatRequest(body: unknown, headers?: HeadersInit) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("API and runtime boundary", () => {
  test("health and empty history do not create an agent session", async () => {
    const state = setup();
    const health = await state.app(new Request("http://localhost/api/health"));
    expect(await health.json()).toEqual({ ok: true, app: "Piko", runtime: "Pi", modelReady: true, activeSessions: 0 });
    const history = await state.app(new Request(`http://localhost/api/sessions/${sessionId}`));
    expect(await history.json()).toEqual({ sessionId, messages: [] });
    expect(state.creations).toBe(0);
  });

  test("rejects invalid and oversized requests before session creation", async () => {
    const state = setup();
    const cases = [
      { body: [], status: 400 },
      { body: { sessionId: "invalid", message: "Hello" }, status: 422 },
      { body: { sessionId, message: "  " }, status: 422 },
      { body: { sessionId, message: "x".repeat(12_001) }, status: 422 },
      { body: { sessionId, message: "x".repeat(65_000) }, status: 413 },
    ];
    for (const { body, status } of cases) expect((await state.app(chatRequest(body))).status).toBe(status);
    expect(state.creations).toBe(0);
  });

  test("rejects a disallowed Origin before starting the runtime", async () => {
    const state = setup();
    const response = await state.app(chatRequest({ sessionId, message: "Hello" }, { Origin: "http://untrusted.example" }));
    expect(response.status).toBe(403);
    expect(state.creations).toBe(0);
  });

  test("streams shared events and returns history through the same session", async () => {
    const state = setup();
    const response = await state.app(chatRequest({ sessionId, message: " Hello " }));
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(consumeSse(await response.text(), true).events.map(({ runId, sequence, ...event }) => event)).toEqual([
      { type: "delta", text: "Hello" }, { type: "done" },
    ]);
    const history = await state.app(new Request(`http://localhost/api/sessions/${sessionId}`));
    expect((await history.json()).messages).toEqual(state.session.messages);
    expect(state.session.messages[0]?.content).toBe("Hello");
    const deleted = await state.app(new Request(`http://localhost/api/sessions/${sessionId}`, { method: "DELETE" }));
    expect(deleted.status).toBe(409);
    expect(state.session.disposed).toBe(false);
    expect(state.conversations.size).toBe(1);
  });

  test("rejects a second turn while that conversation is streaming", async () => {
    const state = setup(new TestSession(true));
    const response = await state.app(chatRequest({ sessionId, message: "First" }));
    await state.session.started.promise;
    const second = await state.app(chatRequest({ sessionId, message: "Second" }));
    expect(second.status).toBe(409);
    await response.body!.cancel();
    expect(state.session.abortCalls).toBe(0);
    await (await state.conversations.run(sessionId))!.cancel();
  });

  test("request abort disconnects its observer without stopping the reply", async () => {
    const state = setup(new TestSession(true));
    const controller = new AbortController();
    const request = new Request("http://localhost/api/chat", { signal: controller.signal });
    const run = await state.conversations.startRun(sessionId, runId, "Hello");
    const response = chatStream(run, request);
    await state.session.started.promise;
    controller.abort();
    expect(state.session.abortCalls).toBe(0);
    expect(run.active).toBe(true);
    expect(consumeSse(await response.text(), true).events).toEqual([{ type: "delta", text: "Hello", runId, sequence: 1 }]);
    await run.cancel();
  });

  test("replacement discards buffered old text and updates the reconnect snapshot", async () => {
    const state = setup(new TestSession(true));
    const run = await state.conversations.startRun(sessionId, runId, "Hello");
    await state.session.started.promise;
    state.session.emit({ type: "delta", text: " old buffered partial" });
    state.session.emit({ type: "replace", text: "corrected" });
    state.session.emit({ type: "delta", text: " answer" });
    await run.cancel();
    while (run.active) await Bun.sleep(1);
    expect(run.snapshot.text).toBe("corrected answer");
    const events: StreamEvent[] = [];
    run.subscribe(0, event => events.push(event));
    expect(events.map(event => event.type)).toEqual(["delta", "replace", "delta", "cancelled"]);
    expect(events[1]).toMatchObject({ type: "replace", text: "corrected" });
    expect(JSON.stringify(events)).not.toContain("old buffered partial");
  });

  test("an already aborted request does not create a session", async () => {
    const state = setup();
    const controller = new AbortController();
    controller.abort();
    const response = await state.app(new Request("http://localhost/api/chat", {
      method: "POST", signal: controller.signal, body: JSON.stringify({ sessionId, message: "Hello" }),
    }));
    expect(response.status).toBe(499);
    expect(state.creations).toBe(0);
  });

  test("replays only missing events and stops through the explicit Run endpoint", async () => {
    const state = setup(new TestSession(true));
    const response = await state.app(chatRequest({ sessionId, runId, message: "Hello" }));
    await state.session.started.promise;
    await response.body!.cancel();
    const history = await state.app(new Request(`http://localhost/api/sessions/${sessionId}`));
    const snapshot = await history.json();
    expect(snapshot.run).toMatchObject({ id: runId, status: "running", text: "Hello", lastEventId: 1 });
    expect(snapshot.messages).toHaveLength(1);
    const resumed = await state.app(new Request(`http://localhost/api/sessions/${sessionId}/runs/${runId}/events?after=1`));
    const cancel = await state.app(new Request(`http://localhost/api/sessions/${sessionId}/runs/${runId}/cancel`, { method: "POST" }));
    expect(cancel.status).toBe(200);
    expect(consumeSse(await resumed.text(), true).events).toEqual([{ type: "cancelled", runId, sequence: 2 }]);
    expect(state.session.abortCalls).toBe(1);
    const again = await state.app(new Request(`http://localhost/api/sessions/${sessionId}/runs/${runId}/cancel`, { method: "POST" }));
    expect(again.status).toBe(200);
    expect(state.session.abortCalls).toBe(1);
  });

  test("duplicate submissions reuse the Run before session creation finishes", async () => {
    const session = new TestSession(true);
    const gate = Promise.withResolvers<ChatSession>();
    const { repo, readHistory } = storage(session);
    const config = readServerConfig({});
    const runtime: ChatRuntime = { isModelReady: async () => true, readHistory, createSession: () => gate.promise };
    const conversations = new ConversationStore(runtime.createSession, config, repo, readHistory);
    const app = createApp({ config, runtime, conversations });
    const first = await app(chatRequest({ sessionId, runId, message: "Hello" }));
    const duplicate = await app(chatRequest({ sessionId, runId, message: "Hello" }));
    const different = await app(chatRequest({ sessionId, runId: crypto.randomUUID(), message: "Other" }));
    expect(different.status).toBe(409);
    gate.resolve(session);
    await session.started.promise;
    expect(session.promptCalls).toBe(1);
    await (await conversations.run(sessionId))!.cancel();
    expect(await first.text()).toBe(await duplicate.text());
  });

  test("queued cancellation prevents the prompt from starting", async () => {
    const session = new TestSession();
    const gate = Promise.withResolvers<ChatSession>();
    const { repo, readHistory } = storage(session);
    const store = new ConversationStore(() => gate.promise, readServerConfig({}), repo, readHistory);
    const run = await store.startRun(sessionId, runId, "Hello");
    await run.cancel();
    gate.resolve(session);
    await store.get(sessionId);
    expect(run.snapshot.status).toBe("cancelled");
    expect(session.promptCalls).toBe(0);
  });

  test("validates cursor, run identity and deletion while a reply is active", async () => {
    const state = setup(new TestSession(true));
    const response = await state.app(chatRequest({ sessionId, runId, message: "Hello" }));
    await state.session.started.promise;
    expect((await state.app(chatRequest({ sessionId, runId, message: "Different" }))).status).toBe(409);
    const events = `http://localhost/api/sessions/${sessionId}/runs/${runId}/events`;
    expect((await state.app(new Request(`${events}?after=-1`))).status).toBe(422);
    expect((await state.app(new Request(`${events}?after=99`))).status).toBe(409);
    expect((await state.app(new Request(events.replace(runId, crypto.randomUUID())))).status).toBe(404);
    expect((await state.app(new Request(`http://localhost/api/sessions/${sessionId}`, { method: "DELETE" }))).status).toBe(409);
    await response.body!.cancel();
    await (await state.conversations.run(sessionId))!.cancel();
  });

  test("a completed or retired runId never starts a second prompt", async () => {
    const state = setup();
    const first = await state.app(chatRequest({ sessionId, runId, message: "Hello" }));
    await first.text();
    const duplicate = await state.app(chatRequest({ sessionId, runId, message: "Hello" }));
    await duplicate.text();
    expect(state.session.promptCalls).toBe(1);
    const second = await state.app(chatRequest({ sessionId, runId: crypto.randomUUID(), message: "Next" }));
    await second.text();
    expect((await state.app(chatRequest({ sessionId, runId, message: "Hello" }))).status).toBe(409);
    expect(state.session.promptCalls).toBe(2);
  });

  test("session creation failures keep the error and transient input without inventing native history", async () => {
    const { repo, readHistory } = storage();
    const config = readServerConfig({});
    const runtime: ChatRuntime = {
      readHistory,
      isModelReady: async () => false,
      createSession: async () => { throw new Error("No model configured."); },
    };
    const conversations = new ConversationStore(runtime.createSession, config, repo, readHistory);
    const app = createApp({ config, runtime, conversations });
    const response = await app(chatRequest({ sessionId, runId, message: "Hello" }));
    expect(consumeSse(await response.text(), true).events).toEqual([
      { type: "error", message: "No model configured.", runId, sequence: 1 },
    ]);
    const history = await app(new Request(`http://localhost/api/sessions/${sessionId}`));
    const snapshot = await history.json();
    expect(snapshot.run).toMatchObject({ status: "failed", error: "No model configured." });
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.run.message).toBe("Hello");
  });


  test("stream batches remain recoverable from the live snapshot without writing delta metadata", async () => {
    const state = setup(new TestSession(true));
    const response = await state.app(chatRequest({ sessionId, runId, message: "Hello" }));
    await state.session.started.promise;
    await response.body!.cancel();
    for (let i = 0; i < 2048; i++) state.session.emit({ type: "delta", text: "x" });
    await Bun.sleep(60);
    const events = `http://localhost/api/sessions/${sessionId}/runs/${runId}/events`;
    expect((await state.app(new Request(`${events}?after=999`))).status).toBe(409);
    const snapshot = (await state.conversations.run(sessionId))!.snapshot;
    expect(snapshot.text).toBe("Hello" + "x".repeat(2048));
    expect(state.repo.run(sessionId, runId)?.lastEventId).toBe(0);
    const resumed = await state.app(new Request(`${events}?after=${snapshot.lastEventId}`));
    await (await state.conversations.run(sessionId))!.cancel();
    expect(consumeSse(await resumed.text(), true).events).toEqual([{ type: "cancelled", runId, sequence: snapshot.lastEventId + 1 }]);
  });

  test("a failed cancel leaves the Run active and a successful retry can stop it", async () => {
    const session = new TestSession(true);
    const originalAbort = session.abort.bind(session);
    let failures = 1;
    session.abort = async () => { if (failures-- > 0) throw new Error("Stop failed."); await originalAbort(); };
    const state = setup(session);
    const response = await state.app(chatRequest({ sessionId, runId, message: "Hello" }));
    await session.started.promise;
    const cancelRequest = () => new Request(`http://localhost/api/sessions/${sessionId}/runs/${runId}/cancel`, { method: "POST" });
    expect((await state.app(cancelRequest())).status).toBe(500);
    expect((await state.conversations.run(sessionId))!.snapshot.status).toBe("running");
    expect((await state.app(cancelRequest())).status).toBe(200);
    expect(consumeSse(await response.text(), true).events.at(-1)?.type).toBe("cancelled");
  });
});

describe("conversation lifecycle", () => {

  test("disposing and recreating a runtime cache preserves history and durable deduplication", async () => {
    const state = setup();
    await (await state.app(chatRequest({ sessionId, runId, message: "First" }))).text();
    const before = await state.conversations.history(sessionId);
    await state.conversations.dispose();
    const recreated = new ConversationStore(async () => state.session, readServerConfig({}), state.repo, state.readHistory);
    expect(await recreated.history(sessionId)).toEqual(before);
    expect((await recreated.startRun(sessionId, runId, "First")).canReplay(0)).toBe(false);
    expect(state.session.promptCalls).toBe(1); await recreated.dispose();
  });

  test("concurrent requests share a single pending session creation", async () => {
    const state = setup();
    const [first, second] = await Promise.all([state.conversations.get(sessionId), state.conversations.get(sessionId)]);
    expect(first).toBe(second);
    expect(state.creations).toBe(1);
  });

  test("capacity eviction preserves streaming sessions", async () => {
    const active = new TestSession(true);
    const { repo, readHistory } = storage(active);
    const store = new ConversationStore(async () => active, { idleSessionMs: 60_000, maxSessions: 1 }, repo, readHistory);
    await store.get(sessionId);
    active.isStreaming = true;
    await expect(store.get("other")).rejects.toThrow("Piko is busy");
    expect(active.disposed).toBe(false);
  });
});
