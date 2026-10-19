import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { cleanup, fixture, waitUntil } from "./fixtures/durable";

const worker = (context: Parameters<FauxResponseFactory>[0]) => getCurrentSystemPrompt(context.messages).includes("You are a background workspace assistant delegated by the main assistant.");
const lastUser = (context: Parameters<FauxResponseFactory>[0]) => String(context.messages.findLast(message => message.role === "user")?.content);

test("main-agent item management tools preserve verified Telegram provenance for scheduled results", async () => {
  const f = await fixture(); const session = await f.createSession(); let replies = 0;
  session.subscribeBackgroundReplies(async reply => {
    expect(reply.source).toEqual({ channel: "telegram", botId: "bot", chatId: "private-chat" }); replies++;
  });
  const rule = { type: "once" as const, at: Date.now() - 1 };
  const route: FauxResponseFactory = context => {
    if (worker(context)) return fauxAssistantMessage("Scheduled findings");
    if (lastUser(context).includes("Internal result from subagent")) return fauxAssistantMessage("Scheduled summary");
    if (context.messages.findLast(message => message.role !== "system")?.role === "toolResult") return fauxAssistantMessage("Created the item");
    return fauxAssistantMessage(fauxToolCall("work_item", { action: "create", title: "TG item", prompt: "Check the source", schedule: rule }), { stopReason: "toolUse" });
  };
  f.faux.setResponses(Array.from({ length: 12 }, () => route));
  const input = await session.submit("Create this check", "telegram:bot:private-chat:1", { channel: "telegram", botId: "bot", chatId: "private-chat" });
  await waitUntil(async () => (await session.submission(input.submission.requestId!))?.status === "done");
  const service = session.workItems(); await service.tick();
  await waitUntil(async () => (await session.snapshot()).messages.some(message => message.content === "Scheduled summary"));
  expect(replies).toBe(1); expect((await service.list())[0].title).toBe("TG item");
  expect((await service.detail((await service.list())[0].id)).executions).toHaveLength(1);
  expect((await session.snapshot()).messages.filter(message => message.role === "user")).toHaveLength(1);
}, 15000);

test("completed item results recover only the report phase after restart and retain their item directory", async () => {
  const f = await fixture(); const session = await f.createSession(); const service = session.workItems();
  const attachment = Promise.withResolvers<void>(); const notified = Promise.withResolvers<void>(); cleanup(() => attachment.resolve());
  session.subscribeBackgroundReplies(async () => { notified.resolve(); await attachment.promise; });
  let workers = 0; let reports = 0;
  const route: FauxResponseFactory = context => {
    if (worker(context)) { workers++; return fauxAssistantMessage("Saved findings"); }
    reports++; return fauxAssistantMessage("Recovered item summary");
  };
  f.faux.setResponses(Array.from({ length: 8 }, () => route));
  const item = await service.command({ action: "create", requestId: "create", item: { title: "Research", prompt: "Research", schedule: null } });
  const run = await service.command({ action: "run", requestId: "run", id: item.id }); await notified.promise;
  const closing = f.runtime.dispose(); attachment.resolve(); await closing;
  const runtime = f.createRuntime(); const restored = await runtime.createSession();
  await waitUntil(async () => (await restored.snapshot()).messages.some(message => message.content === "Recovered item summary"));
  expect(workers).toBe(1); expect(reports).toBe(1);
  expect((await restored.workItems().result(item.id, run.executionId!)).execution.status).toBe("completed");
  await runtime.dispose(); const last = await f.createRuntime().createSession(); await last.native.waitForIdle(ctx);
  expect(workers).toBe(1); expect(reports).toBe(1);
}, 15000);

test("a cancelled management call cannot admit a fresh item execution", async () => {
  const f = await fixture(); const session = await f.createSession();
  const service = session.workItems(); const item = await service.command({ action: "create", requestId: "create", item: { title: "Research", prompt: "Research", schedule: null } });
  const controller = new AbortController(); controller.abort();
  await expect(service.command({ action: "run", requestId: "cancelled", id: item.id }, { channel: "app" }, controller.signal)).rejects.toThrow();
  expect((await service.detail(item.id)).executions).toHaveLength(0);
});
