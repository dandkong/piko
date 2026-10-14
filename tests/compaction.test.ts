import { expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fixture, cleanup, waitUntil } from "./fixtures/durable";
import type { TestChatSession as DurableChatSession } from "./fixtures/durable";
import { runtimeRequest } from "../server/runtime/http";

async function history() {
  const f = await fixture(); const session = await f.createSession() as DurableChatSession;
  f.faux.setResponses([fauxAssistantMessage("old answer"), fauxAssistantMessage("recent answer")]);
  await session.prompt("Old context. ".repeat(10000), { id: crypto.randomUUID(), createdAt: 1 });
  await session.prompt("Recent context. ".repeat(6000), { id: crypto.randomUUID(), createdAt: 2 });
  return { ...f, session, before: (await f.runtime.readHistory()).messages };
}

test("compact skips an empty context without invoking the model and HTTP exposes the result", async () => {
  const f = await fixture();
  const response = await runtimeRequest(new Request("http://local/api/runtime/compact", { method: "POST" }), f.runtime);
  expect(await response!.json()).toEqual({ ok: true, status: "skipped", reason: "no_summary" });
  expect(f.faux.state.callCount).toBe(0);
});

test("compact reports success only after its summary write is applied and preserves history", async () => {
  const f = await history(); f.faux.setResponses([fauxAssistantMessage("Saved summary.")]);
  expect(await f.runtime.compact!()).toEqual({ status: "compacted" });
  expect((await f.session.native.context(ctx)).messages.some(message => JSON.stringify(message).includes("Saved summary."))).toBe(true);
  expect((await f.runtime.readHistory()).messages).toEqual(f.before);
});

test("a summary made obsolete by a new context is skipped rather than reported as applied", async () => {
  const f = await history(); const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
  cleanup(() => gate.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await gate.promise; return fauxAssistantMessage("Obsolete summary."); }]);
  const pending = f.runtime.compact!(); await entered.promise;
  await f.session.native.reset(undefined, ctx); gate.resolve();
  expect(await pending).toEqual({ status: "skipped", reason: "stale" });
  expect(JSON.stringify((await f.session.native.context(ctx)).messages)).not.toContain("Obsolete summary.");
  expect((await f.runtime.readHistory()).messages).toEqual(f.before);
});

test("stopping summary generation reports cancellation and leaves full history intact", async () => {
  const f = await history(); const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
  cleanup(() => gate.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await gate.promise; return fauxAssistantMessage("Cancelled summary."); }]);
  const pending = f.runtime.compact!(); await entered.promise;
  const stopped = f.session.abort(); gate.resolve(); await stopped;
  expect(await pending).toEqual({ status: "cancelled" });
  expect((await f.runtime.readHistory()).messages).toEqual(f.before);
});

test("failed summarization reports failure instead of success and releases the idle guard", async () => {
  const f = await history();
  f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary failure" })]);
  await expect(f.runtime.compact!()).rejects.toThrow("summary failure");
  expect(f.session.isStreaming).toBe(false);
  expect((await f.runtime.readHistory()).messages).toEqual(f.before);
});


test("maintenance rejects new input immediately and conversation stop can cancel it", async () => {
  const f = await history(); const { ConversationStore } = await import("../server/chat/conversations");
  const store = new ConversationStore(f.runtime); cleanup(() => store.close());
  const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>(); cleanup(() => gate.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await gate.promise; return fauxAssistantMessage("Cancelled."); }]);
  const pending = store.changeRuntime(() => f.runtime.compact!()); await entered.promise;
  await expect(store.submit("Must not be queued", "maintenance-input")).rejects.toThrow("Stop the current reply");
  const stopped = store.stop("maintenance-stop");
  await waitUntil(async () => (await f.session.nativeHarness.inspect(ctx)).tasks.some(task => task.record.abortRequested));
  gate.resolve(); await stopped;
  expect(await pending).toEqual({ status: "cancelled" });
  expect(await f.session.submission("maintenance-input")).toBeUndefined();
  expect((await store.snapshot()).busy).toBe(false);
});
