import { describe, expect, test } from "bun:test";
import type { Message, StreamEvent } from "../shared/chat";
import { consumeSse } from "../shared/sse";
import { createApp } from "../server/app";
import { ConversationStore } from "../server/chat/conversations";
import { chatStream } from "../server/chat/stream";
import { readServerConfig } from "../server/config";
import type { ChatRuntime, ChatSession } from "../server/runtime/types";

const sessionId = "b9b7c60a-b2e2-4af0-8a61-fb0903629aca";

class TestSession implements ChatSession {
  isStreaming = false;
  messages: Message[] = [];
  abortCalls = 0;
  disposed = false;
  readonly started = Promise.withResolvers<void>();
  private readonly finished = Promise.withResolvers<void>();
  private readonly listeners = new Set<(event: StreamEvent) => void>();

  constructor(private readonly hold = false) { }

  subscribe(listener: (event: StreamEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async prompt(text: string) {
    this.isStreaming = true;
    this.started.resolve();
    this.messages.push({ id: "user", role: "user", content: text, createdAt: 1 });
    for (const listener of this.listeners) listener({ type: "delta", text: "Hello" });
    if (this.hold) await this.finished.promise;
    this.isStreaming = false;
    this.messages.push({ id: "assistant", role: "assistant", content: "Hello", createdAt: 2 });
  }

  async abort() {
    this.abortCalls++;
    this.isStreaming = false;
    this.finished.resolve();
  }

  dispose() { this.disposed = true; }
}

function setup(session = new TestSession()) {
  let creations = 0;
  const config = readServerConfig({});
  const runtime: ChatRuntime = {
    isModelReady: async () => true,
    createSession: async () => { creations++; return session; },
  };
  const conversations = new ConversationStore(runtime.createSession, config);
  const app = createApp({ config, runtime, conversations });
  return { app, conversations, session, get creations() { return creations; } };
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
    expect(consumeSse(await response.text(), true).events).toEqual([
      { type: "delta", text: "Hello" }, { type: "done" },
    ]);
    const history = await state.app(new Request(`http://localhost/api/sessions/${sessionId}`));
    expect((await history.json()).messages).toEqual(state.session.messages);
    expect(state.session.messages[0]?.content).toBe("Hello");
    const deleted = await state.app(new Request(`http://localhost/api/sessions/${sessionId}`, { method: "DELETE" }));
    expect(deleted.status).toBe(200);
    expect(state.session.disposed).toBe(true);
    expect(state.conversations.size).toBe(0);
  });

  test("rejects a second turn while that conversation is streaming", async () => {
    const state = setup(new TestSession(true));
    const response = await state.app(chatRequest({ sessionId, message: "First" }));
    await state.session.started.promise;
    const second = await state.app(chatRequest({ sessionId, message: "Second" }));
    expect(second.status).toBe(409);
    await response.body!.cancel();
    expect(state.session.abortCalls).toBe(1);
  });

  test("request abort stops the active prompt and closes its stream", async () => {
    const state = setup(new TestSession(true));
    const controller = new AbortController();
    const request = new Request("http://localhost/api/chat", { signal: controller.signal });
    const response = chatStream(state.conversations, request, sessionId, "Hello");
    await state.session.started.promise;
    controller.abort();
    expect(state.session.abortCalls).toBe(1);
    expect(consumeSse(await response.text(), true).events).toEqual([{ type: "delta", text: "Hello" }]);
  });

  test("an already aborted request does not create a session", async () => {
    const state = setup();
    const controller = new AbortController();
    controller.abort();
    const response = chatStream(state.conversations, new Request("http://localhost/api/chat", { signal: controller.signal }), sessionId, "Hello");
    expect(await response.text()).toBe("");
    expect(state.creations).toBe(0);
  });
});

describe("conversation lifecycle", () => {
  test("concurrent requests share a single pending session creation", async () => {
    const state = setup();
    const [first, second] = await Promise.all([state.conversations.get(sessionId), state.conversations.get(sessionId)]);
    expect(first).toBe(second);
    expect(state.creations).toBe(1);
  });

  test("capacity eviction preserves streaming sessions", async () => {
    const active = new TestSession(true);
    const store = new ConversationStore(async () => active, { idleSessionMs: 60_000, maxSessions: 1 });
    await store.get(sessionId);
    active.isStreaming = true;
    await expect(store.get("other")).rejects.toThrow("Piko is busy");
    expect(active.disposed).toBe(false);
  });
});
