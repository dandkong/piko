import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { fixture, repository, cleanup, waitUntil } from "./fixtures/durable";
import { ConversationStore } from "../server/chat/conversations";
import { defaultServerConfig } from "../server/config";
import { DurableChatSession } from "../server/runtime/pi";
import { createApp } from "../server/app";
import { consumeSse } from "../shared/sse";
import { chatStream } from "../server/chat/stream";

async function setup() {
  const f = await fixture(); const repo = repository(f.paths);
  const config = defaultServerConfig();
  const store = new ConversationStore(f.runtime.createSession, config, repo, f.runtime.readHistory);
  cleanup(() => store.close());
  return { ...f, repo, config, store, app: createApp({ config, runtime: f.runtime, conversations: store }) };
}

test("RN and TG steers all join the next tool boundary with distinct identities and one shared reply", async () => {
  const f = await setup(); const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
  cleanup(() => gate.resolve());
  let seen = "";
  f.faux.setResponses([
    async () => { entered.resolve(); await gate.promise; return fauxAssistantMessage([
      { type: "text", text: "Before." }, fauxToolCall("read", { path: "MEMORY.md" }),
    ], { stopReason: "toolUse" }); },
    context => { seen = JSON.stringify(context.messages); return fauxAssistantMessage("After."); },
  ]);
  const id = f.store.main.sessionId;
  const root = await f.store.startRun(id, crypto.randomUUID(), "original request");
  const output = chatStream(root, new Request("http://local/events")).text();
  await entered.promise;
  const rnId = crypto.randomUUID(); const rn = await f.store.startRun(id, rnId, "RN correction");
  const tgInput = { botId: "1", chatId: "2", messageId: "3", actorId: "2" };
  const tg = await f.store.startTelegram(tgInput, "TG supplement");
  expect(tg.disposition).toBe("accepted");
  expect(rn.snapshot.executionId).toBe(root.snapshot.id);
  expect(tg.run!.snapshot.executionId).toBe(root.snapshot.id);
  const session = await f.runtime.createSession(f.store.context()) as DurableChatSession;
  await waitUntil(async () => (await session.nativeHarness.commit(tx => tx.submissionByRequest(session.native.id, tg.runId!), ctx))?.status === "queued");
  expect((await f.store.history(id)).map(message => message.content)).toEqual(["original request", "RN correction", "TG supplement"]);
  expect((await f.store.startRun(id, rnId, "RN correction"))).toBe(rn);
  expect((await f.store.startTelegram(tgInput, "TG supplement")).duplicate).toBe(true);
  await expect(f.store.startRun(id, rnId, "changed")).rejects.toThrow("already used");
  const selected = await (await f.app(new Request(`http://local/api/sessions/${id}?runId=${root.snapshot.id}`))).json();
  expect(selected.run.id).toBe(root.snapshot.id);
  gate.resolve(); await waitUntil(() => !root.active && !rn.active && !tg.run!.active);
  expect(seen).toContain("RN correction"); expect(seen).toContain("TG supplement");
  expect(f.faux.state.callCount).toBe(2);
  for (const run of [root, rn, tg.run!]) expect(run.snapshot).toMatchObject({ status: "succeeded", text: "Before.After." });
  const history = await f.store.history(id);
  expect(session.messages).toEqual(history);
  expect(history.map(message => message.content)).toEqual(["original request", "Before.", "RN correction", "TG supplement", "After."]);
  expect(history.filter(message => message.role === "user").map(message => message.runId)).toEqual([root.snapshot.id, rnId, tg.runId!]);
  const events = consumeSse(await output, true).events;
  expect(events.filter(event => event.type === "refresh")).toHaveLength(3);
  expect(events.at(-1)?.type).toBe("done");
  await f.store.close();
  const restored = await f.runtime.readHistory(f.store.context());
  expect(restored.messages).toEqual(history);
  expect(restored.runs.get(rnId)).toEqual({ message: "RN correction", text: "Before.After.", executionId: root.snapshot.id });
  expect(f.faux.state.callCount).toBe(2);
});

test("late input observers inherit existing text and steers continue at a final-answer boundary", async () => {
  const f = await setup(); const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
  cleanup(() => gate.resolve());
  let seen = "";
  f.faux.setResponses([
    fauxAssistantMessage([{ type: "text", text: "Before." }, fauxToolCall("read", { path: "MEMORY.md" })], { stopReason: "toolUse" }),
    async () => { entered.resolve(); await gate.promise; return fauxAssistantMessage("After."); },
    context => { seen = JSON.stringify(context.messages); return fauxAssistantMessage("Final."); },
  ]);
  const root = await f.store.startRun(f.store.main.sessionId, crypto.randomUUID(), "first"); await entered.promise;
  await waitUntil(() => root.snapshot.text === "Before.");
  const added = await f.store.startRun(f.store.main.sessionId, crypto.randomUUID(), "late correction");
  const session = await f.runtime.createSession(f.store.context()) as DurableChatSession;
  await waitUntil(async () => (await session.nativeHarness.commit(tx => tx.submissionByRequest(session.native.id, added.snapshot.id), ctx))?.status === "queued");
  expect(added.snapshot.text).toBe("Before."); expect(added.messageEnds).toEqual([7]);
  gate.resolve(); await waitUntil(() => !root.active && !added.active);
  expect(seen).toContain("late correction"); expect(f.faux.state.callCount).toBe(3);
  expect(root.snapshot.text).toBe("Before.After.Final."); expect(added.snapshot.text).toBe(root.snapshot.text);
  expect(added.messageEnds).toEqual(root.messageEnds);
});

test("stopping any participating input stops the execution and withdraws unapplied steers", async () => {
  const f = await setup(); const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
  cleanup(() => gate.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await gate.promise; return fauxAssistantMessage("late"); }]);
  const root = await f.store.startRun(f.store.main.sessionId, crypto.randomUUID(), "first");
  await entered.promise;
  const added = await f.store.startRun(f.store.main.sessionId, crypto.randomUUID(), "second");
  const session = await f.runtime.createSession(f.store.context()) as DurableChatSession;
  await waitUntil(async () => (await session.nativeHarness.commit(tx => tx.submissionByRequest(session.native.id, added.snapshot.id), ctx))?.status === "queued");
  const stopped = added.cancel();
  await waitUntil(async () => (await session.nativeHarness.commit(tx => tx.submissionByRequest(session.native.id, added.snapshot.id), ctx))?.status === "unanswered");
  gate.resolve(); await stopped;
  await waitUntil(() => !root.active && !added.active);
  expect(root.snapshot.status).toBe("cancelled"); expect(added.snapshot.status).toBe("cancelled");
  expect(f.faux.state.callCount).toBe(1);
  expect((await f.store.history(f.store.main.sessionId)).filter(message => message.role === "user").map(message => message.content)).toEqual(["first"]);
});

test("a failed execution settles queued steers without automatically replaying their inputs", async () => {
  const f = await setup();
  await writeFile(join(f.paths.home, "config/settings.json"), JSON.stringify({ version: 1, retry: { enabled: false } }));
  const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>(); cleanup(() => gate.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await gate.promise; return fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failure" }); }]);
  const root = await f.store.startRun(f.store.main.sessionId, crypto.randomUUID(), "first"); await entered.promise;
  const added = await f.store.startRun(f.store.main.sessionId, crypto.randomUUID(), "queued correction");
  const session = await f.runtime.createSession(f.store.context()) as DurableChatSession;
  await waitUntil(async () => (await session.nativeHarness.commit(tx => tx.submissionByRequest(session.native.id, added.snapshot.id), ctx))?.status === "queued");
  gate.resolve(); await waitUntil(() => !root.active && !added.active);
  expect(root.snapshot.status).toBe("failed"); expect(added.snapshot.status).toBe("failed");
  expect(added.snapshot.error).toContain("provider failure");
  expect(f.faux.state.callCount).toBe(1);
});
