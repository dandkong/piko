import { expect, test } from "bun:test";
import { observeConversation, submitMessage } from "../apps/mobile/src/features/chat/transport";
import { encodeSse } from "../shared/sse";
import type { StreamEvent } from "../shared/chat";

test("lost input acknowledgements retry the same identity and message", async () => {
  const bodies: unknown[] = []; let calls = 0;
  const result = await submitMessage("Hello", "stable", new AbortController().signal, {
    fetch: async (_path, init) => {
      bodies.push(JSON.parse(init!.body as string));
      if (++calls === 1) throw new Error("lost acknowledgement");
      return Response.json({ submission: { id: "3" }, duplicate: true });
    }, wait: async () => {},
  });
  expect(result.duplicate).toBe(true);
  expect(bodies).toEqual([{ requestId: "stable", message: "Hello" }, { requestId: "stable", message: "Hello" }]);
});

test("reconnect always requests a fresh snapshot and never resubmits input or carries an event cursor", async () => {
  const controller = new AbortController(); const paths: string[] = []; const events: StreamEvent[] = [];
  await observeConversation({ signal: controller.signal, onReconnecting: () => {}, onEvent: event => {
    events.push(event); if (events.length === 2) controller.abort();
  } }, { fetch: async (path, init) => {
    expect(init?.method).toBeUndefined(); paths.push(path);
    return new Response(encodeSse({ type: "snapshot", conversation: { messages: [{ id: `pi-${paths.length}`, role: "assistant", content: `saved-${paths.length}`, createdAt: 1 }], busy: false } }));
  }, wait: async () => {} });
  expect(paths).toEqual(["/api/chat/events", "/api/chat/events"]);
  expect(events.filter(event => event.type === "snapshot").map(event => event.conversation.messages[0]?.content)).toEqual(["saved-1", "saved-2"]);
});

test("malformed frames trigger reconnect and are replaced by the next authoritative snapshot", async () => {
  const controller = new AbortController(); let fetches = 0; const events: StreamEvent[] = []; const reconnecting: boolean[] = [];
  await observeConversation({ signal: controller.signal, onReconnecting: value => reconnecting.push(value), onEvent: event => {
    events.push(event); controller.abort();
  } }, { fetch: async () => {
    fetches++;
    return new Response(fetches === 1 ? "data: {bad}\n\n" : encodeSse({ type: "snapshot", conversation: { messages: [], busy: false } }));
  }, wait: async () => {} });
  expect(fetches).toBe(2); expect(events).toEqual([{ type: "snapshot", conversation: { messages: [], busy: false } }]);
  expect(reconnecting).toContain(true);
});

test("a connected observer receives a snapshot followed by live message updates", async () => {
  const controller = new AbortController(); const events: StreamEvent[] = [];
  const frames: StreamEvent[] = [
    { type: "snapshot", conversation: { messages: [], busy: true } },
    { type: "message", message: { id: "live-test", role: "assistant", content: "Streaming", createdAt: 1 }, final: false },
    { type: "message", message: { id: "pi-2", role: "assistant", content: "Saved", createdAt: 1 }, previousId: "live-test", final: true },
  ];
  await observeConversation({ signal: controller.signal, onReconnecting: () => {}, onEvent: event => {
    events.push(event); if (events.length === frames.length) controller.abort();
  } }, { fetch: async () => new Response(frames.map(encodeSse).join("")) });
  expect(events).toEqual(frames);
});
