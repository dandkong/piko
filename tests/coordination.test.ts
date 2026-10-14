import { expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import type { BackgroundReply } from "../server/runtime/types";
import type { StreamEvent } from "../shared/chat";
import { ConversationStore } from "../server/chat/conversations";
import { fixture, cleanup, waitUntil } from "./fixtures/durable";

test("direct runtime selection reserves the same input line as Store submissions and releases it after failure", async () => {
  const f = await fixture(); const session = await f.createSession(); const store = new ConversationStore(f.runtime); cleanup(() => store.close());
  const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>(); cleanup(() => gate.resolve());
  const available = f.models.getAvailable.bind(f.models);
  f.models.getAvailable = async provider => { entered.resolve(); await gate.promise; return available(provider); };
  const selection = f.runtime.configure({ provider: "faux", model: "missing" }); await entered.promise;
  await expect(store.submit("Not admitted", "during-selection")).rejects.toThrow("Stop the current reply");
  await expect(f.runtime.compact()).rejects.toThrow("Stop the current reply");
  expect(await session.submission("during-selection")).toBeUndefined();
  gate.resolve(); await expect(selection).rejects.toThrow("unavailable");
  expect(session.isStreaming).toBe(false);
  f.faux.setResponses([fauxAssistantMessage("Recovered")]);
  await session.prompt("Next", { id: "after-selection", createdAt: 1 });
  expect(session.messages.at(-1)?.content).toBe("Recovered");
});

test("a submission that wins admission cannot race a model change on another entry point", async () => {
  const f = await fixture(); const session = await f.createSession(); const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>(); cleanup(() => gate.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await gate.promise; return fauxAssistantMessage("Original model"); }]);
  const input = session.submit("Work", "first-in-line");
  const selection = session.configure({ provider: "faux", model: "reasoning", thinking: "high" });
  await input; await expect(selection).rejects.toThrow("Stop the current reply"); await entered.promise;
  expect((await session.describe()).selection?.model).toBe("fast");
  gate.resolve(); await waitUntil(async () => (await session.submission("first-in-line"))?.status === "done");
});

test("new input sent by a failure observer runs after cleanup and cannot be withdrawn with the failed turn", async () => {
  const f = await fixture(); const session = await f.createSession(); let next: ReturnType<typeof session.submit> | undefined;
  const unsubscribe = session.subscribe(event => {
    if (event.type === "error") next ??= session.submit("Explicit next request", "after-error-event");
  }); cleanup(unsubscribe);
  f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "First failed" }), fauxAssistantMessage("New answer")]);
  await session.submit("First", "failed-turn");
  await waitUntil(() => next !== undefined); await next;
  await waitUntil(async () => (await session.submission("after-error-event"))?.status === "done");
  expect((await session.snapshot()).messages.at(-1)?.content).toBe("New answer");
  expect((await session.submission("failed-turn"))?.status).toBe("unanswered");
});

test("disposing during maintenance cancels it instead of waiting indefinitely for model output", async () => {
  const f = await fixture(); const session = await f.createSession();
  f.faux.setResponses([fauxAssistantMessage("Old answer"), fauxAssistantMessage("Recent answer")]);
  await session.prompt("Old context. ".repeat(10000), { id: "old", createdAt: 1 });
  await session.prompt("Recent context. ".repeat(6000), { id: "recent", createdAt: 2 });
  const history = (await session.snapshot()).messages;
  const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>(); cleanup(() => gate.resolve());
  f.faux.setResponses([async (_context, options) => {
    options?.signal?.addEventListener("abort", () => gate.resolve(), { once: true }); entered.resolve(); await gate.promise;
    return fauxAssistantMessage("Unused summary");
  }]);
  const compaction = f.runtime.compact(); await entered.promise;
  await f.runtime.dispose(); expect(await compaction).toEqual({ status: "cancelled" });
  expect((await f.runtime.readHistory()).messages).toEqual(history);
});

test("a background result completed before Store and TG subscribe is buffered once by Session", async () => {
  const f = await fixture(); const session = await f.createSession(); const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>(); cleanup(() => gate.resolve());
  const route: FauxResponseFactory = async context => {
    if (getCurrentSystemPrompt(context.messages).includes("You are a background workspace assistant delegated")) {
      entered.resolve(); await gate.promise; return fauxAssistantMessage("Private findings");
    }
    if (JSON.stringify(context.messages.findLast(message => message.role === "user")?.content).includes("Internal result")) return fauxAssistantMessage("Main summary");
    if (context.messages.findLast(message => message.role !== "system")?.role === "toolResult") return fauxAssistantMessage("Accepted");
    return fauxAssistantMessage(fauxToolCall("subagent", { action: "spawn", task: "Research" }), { stopReason: "toolUse" });
  };
  f.faux.setResponses(Array.from({ length: 8 }, () => route));
  await session.submit("Delegate", "tg-origin", { channel: "telegram", botId: "77", chatId: "42" }); await entered.promise; gate.resolve();
  await waitUntil(async () => (await session.snapshot()).messages.some(message => message.content === "Main summary"));
  const store = new ConversationStore(f.runtime); cleanup(() => store.close()); const replies: BackgroundReply[] = [];
  const unsubscribe = await store.subscribeBackgroundReplies(async reply => { replies.push(reply); });
  await waitUntil(() => replies.length === 1); unsubscribe();
  expect(replies[0]?.source).toEqual({ channel: "telegram", botId: "77", chatId: "42" });
  expect(replies[0]?.requestId).toStartWith("piko:subagent-report:");
  const detach = await store.subscribeBackgroundReplies(async reply => { replies.push(reply); }); detach();
  expect(replies).toHaveLength(1);
});

test("initial observation joins live publication without losing changes while its snapshot is delayed", async () => {
  const f = await fixture(); const session = await f.createSession(); const store = new ConversationStore(f.runtime); cleanup(() => store.close());
  const snapshot = session.snapshot.bind(session); const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>(); cleanup(() => gate.resolve()); let first = true;
  session.snapshot = async options => {
    const state = await snapshot(options);
    if (first) { first = false; entered.resolve(); await gate.promise; }
    return state;
  };
  const events: StreamEvent[] = []; const observing = store.observe(event => events.push(event)); await entered.promise;
  f.faux.setResponses([fauxAssistantMessage("Saved during snapshot")]);
  const input = store.submit("Concurrent input", "snapshot-race");
  await waitUntil(async () => (await session.submission("snapshot-race"))?.status === "done"); gate.resolve();
  const detach = await observing; await input; await store.flush(); detach();
  expect(events[0]?.type).toBe("snapshot");
  const latest = events.findLast(event => event.type === "snapshot");
  expect(latest?.type === "snapshot" && latest.conversation.messages.map(message => message.content)).toEqual(["Concurrent input", "Saved during snapshot"]);
});
