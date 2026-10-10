import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, watchEvents, type AgentEvent, type EntryRecord, type SnapshotEvent } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PiReplyEvents } from "../server/runtime/pi-events";
import { DurableChatSession } from "../server/runtime/pi";
import { readPiEntries } from "../server/runtime/pi-history";
import type { SessionEvent } from "../server/runtime/types";
import { cleanup, fixture, waitUntil } from "./fixtures/durable";

function entry(id: number, kind: string, rest: Partial<EntryRecord> = {}): EntryRecord {
  return { id: id as EntryRecord["id"], conversationId: ROOT_CONVERSATION_ID, kind, ...rest };
}

function rendered(events: SessionEvent[]) {
  let text = "";
  for (const event of events) {
    if (event.type === "delta") text += event.text;
    if (event.type === "replace") text = event.text;
  }
  return text;
}

test("native message changes preserve block order, retry corrections and completed reply boundaries", () => {
  const events: SessionEvent[] = [];
  const reply = new PiReplyEvents(event => events.push(event));
  reply.begin("current");
  reply.apply({ type: "entry_appended", entry: entry(1, "piko.run", { data: { runId: "current" } }) });
  const first = fauxAssistantMessage("First.");
  reply.apply({ type: "message_start", message: first });
  reply.apply({ type: "message_end", entry: entry(2, "pi.assistant", { model: [first] }) });
  reply.apply({ type: "message_start", message: fauxAssistantMessage([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Second" }]) });
  reply.apply({ type: "message_update", usage: first.usage, changes: [
    { type: "thinking_delta", contentIndex: 0, delta: "still hidden" },
    { type: "text_delta", contentIndex: 1, delta: "." },
    { type: "toolcall_start", contentIndex: 2, block: fauxToolCall("read", { path: "secret" }) },
    { type: "text_start", contentIndex: 3, block: { type: "text", text: " End" } },
    { type: "block", contentIndex: 3, block: { type: "text", text: " Finish" } },
  ] });
  expect(rendered(events)).toBe("First.Second. Finish");
  reply.apply({ type: "auto_retry_start", attempt: 1, at: 0, errorMessage: "retry" });
  const corrected = fauxAssistantMessage("New");
  reply.apply({ type: "message_update", usage: corrected.usage, changes: [{ type: "message", message: corrected }] });
  expect(rendered(events)).toBe("First.New");
  expect(events.at(-1)).toEqual({ type: "replace", text: "First.New" });
  reply.apply({ type: "message_start", message: fauxAssistantMessage("OK") });
  const final = entry(3, "pi.assistant", { model: [fauxAssistantMessage("OK.")] });
  reply.apply({ type: "message_end", entry: final });
  reply.apply({ type: "message_end", entry: final });
  expect(rendered(events)).toBe("First.OK.");
  expect(events.filter(event => event.type === "message_end").map(event => event.offset)).toEqual([6, 9]);
});

test("a running snapshot restores completed boundaries and partial text before subsequent deltas", async () => {
  const f = await fixture(); const session = await f.createSession() as DurableChatSession;
  const stream = await watchEvents(session.nativeHarness, session.native.id, ctx);
  cleanup(() => stream.stop());
  const events: SessionEvent[] = []; const reply = new PiReplyEvents(event => events.push(event));
  reply.begin("current");
  const first = entry(4, "pi.assistant", { model: [fauxAssistantMessage("First.")] });
  const snapshot: SnapshotEvent = { ...stream.snapshot, run: { inputs: [] }, generation: { attempt: 2,
    message: fauxAssistantMessage([{ type: "thinking", thinking: "private" }, { type: "text", text: "Part" }]) } };
  reply.restore([
    entry(1, "piko.run", { data: { runId: "old" } }),
    entry(2, "pi.assistant", { model: [fauxAssistantMessage("Old.")] }),
    entry(3, "piko.run", { data: { runId: "current" } }), first,
  ], snapshot);
  expect(rendered(events)).toBe("First.Part");
  const final = fauxAssistantMessage("Partial.");
  reply.apply({ type: "message_update", usage: final.usage, changes: [{ type: "text_delta", contentIndex: 1, delta: "ial." }] });
  reply.apply({ type: "message_end", entry: entry(5, "pi.assistant", { model: [final] }) });
  expect(rendered(events)).toBe("First.Partial.");
  expect(events.filter(event => event.type === "message_end").map(event => event.offset)).toEqual([6, 14]);
  reply.finish();
  const count = events.length;
  reply.apply({ type: "message_start", message: fauxAssistantMessage("late") });
  expect(events).toHaveLength(count);
});

test("native provider retry retains committed attempt messages and their native boundaries", async () => {
  const f = await fixture(200);
  await writeFile(join(f.paths.home, "config/settings.json"), JSON.stringify({ version: 1,
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, stream: { maxRetries: 0 } }));
  const session = await f.createSession();
  const events: SessionEvent[] = []; session.subscribe(event => events.push(event));
  const failed = "Partial text from the failed provider attempt. ".repeat(12);
  f.faux.setResponses([
    fauxAssistantMessage([{ type: "text", text: "First." }, fauxToolCall("read", { path: "MEMORY.md" })], { stopReason: "toolUse" }),
    fauxAssistantMessage(failed, { stopReason: "error", errorMessage: "429 rate limit" }),
    fauxAssistantMessage("OK."),
  ]);
  await session.prompt("retry", { id: crypto.randomUUID(), createdAt: 1 });
  expect(f.faux.state.callCount).toBe(3);
  expect(rendered(events)).toBe("First." + failed + "OK.");
  expect(events.filter(event => event.type === "message_end").map(event => event.offset)).toEqual([6, 6 + failed.length, 9 + failed.length]);
  expect(session.messages.filter(message => message.role === "assistant").map(message => message.content)).toEqual(["First.", failed, "OK."]);
});

test("an overflowing native event watch restores missed replies from full history even after reset", async () => {
  const f = await fixture(); const session = await f.createSession() as DurableChatSession;
  f.faux.setResponses([fauxAssistantMessage("Old history.")]);
  await session.prompt("old", { id: crypto.randomUUID(), createdAt: 1 });
  await session.native.reset(undefined, ctx);
  const run = { id: crypto.randomUUID(), createdAt: 2 };
  const events: SessionEvent[] = []; const reply = new PiReplyEvents(event => events.push(event));
  reply.begin(run.id);
  const stream = await watchEvents(session.nativeHarness, session.native.id, ctx);
  const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
  let snapshots = 0;
  cleanup(async () => { gate.resolve(); await stream.stop(); });
  stream.start(async batch => {
    entered.resolve(); await gate.promise;
    for (const event of batch) {
      if (event.type === "snapshot") {
        snapshots++;
        const all = await readPiEntries(session.nativeHarness);
        const through = event.entries.reduce((latest, entry) => Math.max(latest, entry.id), 0);
        reply.restore(all.filter(entry => entry.id <= through), event);
      } else reply.apply(event);
    }
  });
  await session.native.commit(tx => tx.appendEntry(session.native.id, { kind: "test.hold-events" }), ctx);
  await entered.promise;
  f.faux.setResponses([
    fauxAssistantMessage([{ type: "text", text: "First." }, fauxToolCall("read", { path: "MEMORY.md" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Second."),
  ]);
  await session.prompt("current", run);
  await session.native.reset(undefined, ctx);
  for (let i = 0; i < 120; i++) await session.native.commit(tx => tx.appendEntry(session.native.id, { kind: "test.overflow" }), ctx);
  gate.resolve();
  await waitUntil(() => snapshots > 0 && rendered(events) === "First.Second.");
  expect(events.filter(event => event.type === "message_end").map(event => event.offset)).toEqual([6, 13]);
  expect(session.messages.map(message => message.content)).toEqual(["old", "Old history.", "current", "First.", "Second."]);
});

test("a lagging Piko event consumer reconciles overflow before the prompt settles", async () => {
  const f = await fixture(); const session = await f.createSession() as DurableChatSession;
  const events: SessionEvent[] = []; session.subscribe(event => events.push(event));
  const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
  // Hold delivery, not Durable execution, to exercise the asynchronous completion barrier and overflow path.
  const consumer = session as unknown as { observe(events: readonly AgentEvent[]): Promise<void> };
  const observe = consumer.observe.bind(session);
  consumer.observe = async batch => { entered.resolve(); await gate.promise; await observe(batch); };
  cleanup(() => { gate.resolve(); });
  f.faux.setResponses([
    fauxAssistantMessage([{ type: "text", text: "First." }, fauxToolCall("read", { path: "MEMORY.md" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Second."),
  ]);
  const run = { id: crypto.randomUUID(), createdAt: 1 };
  let done = false;
  const pending = session.prompt("held events", run).then(() => { done = true; });
  await entered.promise;
  await waitUntil(async () => {
    const record = await session.nativeHarness.commit(tx => tx.submissionByRequest(session.native.id, run.id), ctx);
    return record?.status === "done";
  });
  for (let i = 0; i < 120; i++) await session.native.commit(tx => tx.appendEntry(session.native.id, { kind: "test.overflow" }), ctx);
  expect(done).toBe(false);
  gate.resolve(); await pending;
  expect(rendered(events)).toBe("First.Second.");
  expect(events.some(event => event.type === "refresh")).toBe(true);
  expect(events.filter(event => event.type === "message_end").map(event => event.offset)).toEqual([6, 13]);
  expect(session.isStreaming).toBe(false);
  const count = events.length;
  await session.native.commit(tx => tx.appendEntry(session.native.id, { kind: "test.after-done" }), ctx);
  expect(events).toHaveLength(count);
});

test("event listener failure fails the prompt, blocks new generation and releases the native store", async () => {
  const f = await fixture(); const session = await f.createSession() as DurableChatSession;
  const consumer = session as unknown as { observe(events: readonly AgentEvent[]): Promise<void> };
  consumer.observe = async () => { throw new Error("test event listener failure"); };
  f.faux.setResponses([fauxAssistantMessage("Saved answer."), fauxAssistantMessage("Next answer.")]);
  await expect(session.prompt("first", { id: crypto.randomUUID(), createdAt: 1 })).rejects.toThrow("test event listener failure");
  expect(f.faux.state.callCount).toBe(1);
  await expect(session.prompt("blocked", { id: crypto.randomUUID(), createdAt: 2 })).rejects.toThrow("test event listener failure");
  expect(f.faux.state.callCount).toBe(1);
  await session.dispose();
  const reopened = await f.runtime.createSession(f.input);
  expect(reopened.messages.map(message => message.content)).toEqual(["first", "Saved answer."]);
  await reopened.prompt("next", { id: crypto.randomUUID(), createdAt: 3 });
  expect(reopened.messages.at(-1)?.content).toBe("Next answer.");
});
