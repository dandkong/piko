import { describe, expect, test } from "bun:test";
import type { ConversationResponse, RunSnapshot, StreamEvent } from "../shared/chat";
import { encodeSse } from "../shared/sse";
import { observeRun, waitForRetry } from "../apps/mobile/src/features/chat/transport";

const sessionId = "b9b7c60a-b2e2-4af0-8a61-fb0903629aca";
const runId = "7a5c9c78-030a-4c2a-b6f7-13974210b807";
const run: RunSnapshot = { id: runId, status: "running", message: "Hi", text: "", createdAt: 1, lastEventId: 0 };
function event(sequence: number, value: StreamEvent): StreamEvent { return { ...value, runId, sequence }; }
function stream(...events: StreamEvent[]) { return new Response(events.map(encodeSse).join("")); }
function observation(message?: string) {
  const events: StreamEvent[] = [];
  const snapshots: ConversationResponse[] = [];
  const connectionStates: boolean[] = [];
  const controller = new AbortController();
  let ready = 0;
  return {
    events, snapshots, connectionStates, controller, get ready() { return ready; },
    options: {
      sessionId, run, message, signal: controller.signal,
      onEvent: (event: StreamEvent) => { events.push(event); },
      onSnapshot: (snapshot: ConversationResponse) => { snapshots.push(snapshot); },
      onReady: () => { ready++; },
      onReconnecting: (state: boolean) => { connectionStates.push(state); },
    },
  };
}

describe("Run transport recovery", () => {
  test("replayed events are applied once, including split UTF-8 data", async () => {
    const state = observation();
    const bytes = new TextEncoder().encode([
      event(1, { type: "delta", text: "你好" }), event(1, { type: "delta", text: "你好" }), event(2, { type: "done" }),
    ].map(encodeSse).join(""));
    await observeRun(state.options, {
      fetch: async () => new Response(new ReadableStream({ start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      } })),
      load: async () => { throw new Error("Should not reload."); },
    });
    expect(state.events).toEqual([event(1, { type: "delta", text: "你好" }), event(2, { type: "done" })]);
    expect(state.snapshots).toHaveLength(0);
  });

  test("an interrupted reply resumes from its snapshot without duplicating text", async () => {
    const state = observation("Hi");
    const paths: string[] = [];
    let visibleText = "";
    await observeRun({ ...state.options,
      onEvent: (value) => { state.options.onEvent(value); if (value.type === "delta") visibleText += value.text; },
      onSnapshot: (snapshot) => { state.options.onSnapshot(snapshot); visibleText = snapshot.run!.text; },
    }, {
      fetch: async (path) => {
        paths.push(path);
        return paths.length === 1 ? stream(event(1, { type: "delta", text: "Hello" }))
          : stream(event(3, { type: "delta", text: " world" }), event(4, { type: "done" }));
      },
      load: async () => ({ sessionId, messages: [], run: { ...run, text: "Hello!", lastEventId: 2 } }),
      wait: async () => {},
    });
    expect(paths).toEqual(["/api/chat", `/api/sessions/${sessionId}/runs/${runId}/events?after=2`]);
    expect(visibleText).toBe("Hello! world");
    expect(state.connectionStates).toContain(true);
  });

  test("a lost submission response recovers the accepted Run instead of submitting again", async () => {
    const state = observation("Hi");
    let submissions = 0;
    await observeRun(state.options, {
      fetch: async () => { submissions++; throw new TypeError("Network disconnected after acceptance."); },
      load: async () => ({ sessionId, messages: [], run: { ...run, status: "succeeded", text: "Done", lastEventId: 2 } }),
      wait: async () => {},
    });
    expect(submissions).toBe(1);
    expect(state.snapshots[0]?.run?.text).toBe("Done");
    expect(state.events).toEqual([{ type: "done" }]);
  });

  test("failed acceptance retries the same runId", async () => {
    const state = observation("Hi");
    const bodies: unknown[] = [];
    await observeRun(state.options, {
      fetch: async (path, init) => {
        expect(path).toBe("/api/chat");
        bodies.push(JSON.parse(init!.body as string));
        if (bodies.length === 1) throw new TypeError("Offline before acceptance.");
        return stream(event(1, { type: "done" }));
      },
      load: async () => ({ sessionId, messages: [] }), wait: async () => {},
    });
    expect(bodies).toEqual([
      { sessionId, runId, message: "Hi", after: 0 }, { sessionId, runId, message: "Hi", after: 0 },
    ]);
  });

  test("an expired replay cursor reloads the snapshot and subscribes at its new cursor", async () => {
    const state = observation();
    const paths: string[] = [];
    await observeRun(state.options, {
      fetch: async (path) => {
        paths.push(path);
        return paths.length === 1 ? Response.json({ error: "Event history expired." }, { status: 409 })
          : stream(event(2501, { type: "cancelled" }));
      },
      load: async () => ({ sessionId, messages: [], run: { ...run, text: "Long reply", lastEventId: 2500 } }),
      wait: async () => {},
    });
    expect(paths[1]).toEndWith("after=2500");
    expect(state.events).toEqual([event(2501, { type: "cancelled" })]);
  });

  test("when snapshot loading fails, reconnect uses the last received event cursor", async () => {
    const state = observation();
    const paths: string[] = [];
    await observeRun(state.options, {
      fetch: async (path) => {
        paths.push(path);
        return paths.length === 1 ? stream(event(1, { type: "delta", text: "Hello" })) : stream(event(2, { type: "done" }));
      },
      load: async () => { throw new TypeError("Network error."); }, wait: async () => {},
    });
    expect(paths[1]).toEndWith("after=1");
  });

  test("a server restart never silently starts a replacement reply", async () => {
    const state = observation();
    let requests = 0;
    await expect(observeRun(state.options, {
      fetch: async () => { requests++; return Response.json({ error: "Reply is no longer available." }, { status: 404 }); },
      load: async () => ({ sessionId, messages: [] }), wait: async () => {},
    })).rejects.toThrow("no longer available");
    expect(requests).toBe(1);
  });

  test("retries are bounded and use exponential backoff", async () => {
    const state = observation();
    const delays: number[] = [];
    let requests = 0;
    await expect(observeRun(state.options, {
      fetch: async () => { requests++; throw new TypeError("Offline."); },
      load: async () => { throw new TypeError("Offline."); },
      wait: async (delay) => { delays.push(delay); },
    })).rejects.toThrow("Connection interrupted");
    expect(requests).toBe(6);
    expect(delays).toEqual([400, 800, 1600, 3200, 4000]);
  });

  test("aborting a reconnect wait cleans up immediately", async () => {
    const controller = new AbortController();
    const waiting = waitForRetry(60_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });
});
