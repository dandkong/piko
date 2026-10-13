import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { UserEntry } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fixture, cleanup, waitUntil } from "./fixtures/durable";
import { createApp } from "../server/app";
import { ConversationStore } from "../server/chat/conversations";
import { defaultServerConfig } from "../server/config";
import { CHAT_PAGE_SIZE, type ConversationResponse, type HistoryPage, type Message } from "../shared/chat";
import { mergeHistorySnapshot, prependHistoryPage } from "../shared/history";
import { registerInput } from "../server/runtime/input-origin";

const message = (id: number): Message => ({ id: `pi-${id}`, role: "user", content: `saved-${id}`, createdAt: id });
const range = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => message(first + i));
const snapshot = (first: number, last: number, nextBefore?: string): ConversationResponse => ({ messages: range(first, last), busy: false, history: { nextBefore } });

test("paged snapshots retain older pages but replace transient messages and final live aliases", () => {
  const old: HistoryPage = { messages: [...range(1, 100), { id: "live-a", role: "assistant", content: "partial", createdAt: 101 }, { id: "input-cancelled", role: "user", content: "withdrawn", createdAt: 102 }] };
  const result = mergeHistorySnapshot(old, snapshot(52, 101, "52"));
  expect(result.messages).toEqual(range(1, 101));
  expect(result.nextBefore).toBeUndefined();
  expect(mergeHistorySnapshot({ messages: range(51, 100), nextBefore: "51" }, snapshot(52, 101, "52")).nextBefore).toBe("51");
});

test("a reconnect with no overlap resets the window instead of hiding a history gap", () => {
  expect(mergeHistorySnapshot({ messages: range(1, 50) }, snapshot(101, 150, "101"))).toEqual({ messages: range(101, 150), nextBefore: "101" });
  expect(mergeHistorySnapshot({ messages: range(1, 50) }, { messages: [], busy: false, history: {} }).messages).toEqual([]);
});

test("older pages merge with live changes, deduplicate, and stale responses cannot join a reset window", () => {
  const current = { messages: range(51, 101), nextBefore: "51" };
  const older = { messages: range(1, 51) };
  expect(prependHistoryPage(current, older, "51")).toEqual({ messages: range(1, 101), nextBefore: undefined });
  expect(prependHistoryPage(current, older, "1")).toBe(current);
  expect(mergeHistorySnapshot(current, { messages: range(1, 2), busy: false })).toEqual({ messages: range(1, 2) });
});

test("HTTP and initial/recovery SSE expose a bounded recent window; cursors traverse all raw history", async () => {
  const f = await fixture(); const session = await f.createSession();
  await session.native.commit(async tx => {
    for (let i = 1; i <= 135; i++) {
      await tx.appendEntry(UserEntry, session.native.id, { model: [{ role: "user", content: `saved-${i}`, timestamp: i }] });
      if (i % 10 === 0) await tx.appendEntry(session.native.id, { kind: "pi.tool-result", model: [{ role: "user", content: "not visible", timestamp: i }] });
    }
    await tx.appendEntry(session.native.id, { kind: "pi.compaction", model: [{ role: "user", content: "hidden summary", timestamp: 136 }], head: "self" });
    await registerInput(tx, "piko:private", { channel: "app" }, true);
    const hidden = await tx.appendEntry(UserEntry, session.native.id, { model: [{ role: "user", content: "private report", timestamp: 137 }] });
    await tx.createSubmission({ conversationId: session.native.id, type: "input", status: "placed", entry: hidden.id, requestId: "piko:private" });
  }, ctx);
  const store = new ConversationStore(f.runtime); cleanup(() => store.close());
  const app = createApp({ runtime: f.runtime, conversations: store, config: defaultServerConfig() });
  const recent: ConversationResponse = await (await app(new Request("http://local/api/chat"))).json();
  expect(recent.messages).toHaveLength(CHAT_PAGE_SIZE);
  expect(recent.messages[0]?.content).toBe("saved-86");
  expect(recent.messages.at(-1)?.content).toBe("saved-135");
  const seen: ConversationResponse[] = [];
  const unsubscribe = await store.observe(event => { if (event.type === "snapshot") seen.push(event.conversation); });
  expect(seen[0]?.messages).toEqual(recent.messages);
  expect(seen[0]?.history).toEqual(recent.history);
  unsubscribe();
  let all = recent.messages; let before = recent.history?.nextBefore;
  while (before) {
    const response = await app(new Request(`http://local/api/chat/history?before=${before}`));
    expect(response.status).toBe(200);
    const page: HistoryPage = await response.json();
    expect(page.messages.length).toBeLessThanOrEqual(CHAT_PAGE_SIZE);
    all = [...page.messages, ...all]; before = page.nextBefore;
  }
  expect(all.map(item => item.content)).toEqual(Array.from({ length: 135 }, (_, i) => `saved-${i + 1}`));
  expect(new Set(all.map(item => item.id)).size).toBe(135);
  expect((await f.runtime.readHistory()).messages).toHaveLength(135);
  expect((await session.history("1")).messages).toEqual([]);
  for (const cursor of ["", "0", "-1", "1.5", "abc", "9007199254740992"]) expect((await app(new Request(`http://local/api/chat/history?before=${cursor}`))).status).toBe(422);
});

test("native ID pagination is stable across new writes, reset, and restart", async () => {
  const f = await fixture(); const session = await f.createSession();
  await session.native.commit(async tx => {
    for (let i = 1; i <= 120; i++) await tx.appendEntry(UserEntry, session.native.id, { model: [{ role: "user", content: `saved-${i}`, timestamp: i }] });
  }, ctx);
  const recent = await session.history(); const older = await session.history(recent.nextBefore);
  await session.native.reset(undefined, ctx);
  await session.native.commit(tx => tx.appendEntry(UserEntry, session.native.id, { model: [{ role: "user", content: "new", timestamp: 121 }] }), ctx);
  expect(await session.history(recent.nextBefore)).toEqual(older);
  await session.dispose();
  const resumed = await f.createSession();
  expect(await resumed.history(recent.nextBefore)).toEqual(older);
  expect((await resumed.snapshot({ limit: CHAT_PAGE_SIZE })).messages.at(-1)?.content).toBe("new");
  expect(f.faux.state.callCount).toBe(0);
});

test("new submissions retain request IDs in paged snapshots without rescanning old bindings", async () => {
  const f = await fixture(); const session = await f.createSession();
  f.faux.setResponses([fauxAssistantMessage("Answer")]);
  await session.submit("Question", "paged-request");
  await waitUntil(async () => (await session.submission("paged-request"))?.status === "done");
  const state = await session.snapshot({ limit: CHAT_PAGE_SIZE });
  expect(state.messages[0]).toMatchObject({ content: "Question", requestId: "paged-request" });
  expect(state.messages[1]).toMatchObject({ content: "Answer" });
  expect(state.history?.nextBefore).toBeUndefined();
});
