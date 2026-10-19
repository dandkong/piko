import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { ItemFiles, itemDraft, latestDue, nextDue } from "../server/domain/work-items";
import { WorkItems } from "../server/runtime/work-items";
import { ItemContext } from "../server/runtime/item-context";
import { cleanup, fixture, waitUntil } from "./fixtures/durable";
import { createApp } from "../server/app";
import { ConversationStore } from "../server/chat/conversations";
import { defaultServerConfig } from "../server/config";

const isWorker = (context: Parameters<FauxResponseFactory>[0]) => getCurrentSystemPrompt(context.messages).includes("You are a background workspace assistant delegated by the main assistant.");
const lastUser = (context: Parameters<FauxResponseFactory>[0]) => String(context.messages.findLast(message => message.role === "user")?.content);
const setup = async () => { const f = await fixture(); const session = await f.createSession(); return { ...f, session, service: session.workItems() }; };
const draft = (title = "Daily research") => ({ title, prompt: "Research and save a report", schedule: null });
const route: FauxResponseFactory = context => isWorker(context) ? fauxAssistantMessage("Worker findings") : fauxAssistantMessage("Main summary");

test("five-field cron and timezone/DST calculations are validated without scheduling library timers", () => {
  const rule = { type: "cron" as const, expression: "0 9 * * *", timezone: "Asia/Shanghai" };
  expect(nextDue(rule, Date.parse("2026-10-19T00:30:00Z"))).toBe(Date.parse("2026-10-19T01:00:00Z"));
  expect(latestDue(rule, Date.parse("2026-10-19T01:01:00Z"))).toBe(Date.parse("2026-10-19T01:00:00Z"));
  expect(itemDraft({ ...draft(), schedule: rule }).schedule).toEqual(rule);
  expect(() => itemDraft({ ...draft(), schedule: { ...rule, expression: "* * * * * *" } })).toThrow();
  expect(() => itemDraft({ ...draft(), schedule: { ...rule, timezone: "not/a-zone" } })).toThrow();
  expect(() => itemDraft({ ...draft(), schedule: { type: "once", at: Infinity } })).toThrow();
  expect(itemDraft({ ...draft(), scheduleText: " 每天 9:00 " }).scheduleText).toBe("每天 9:00");
  const dst = { ...rule, expression: "30 2 * * *", timezone: "America/New_York" };
  // Croner 10 normalizes the missing spring-forward hour to 03:30 local.
  expect(nextDue(dst, Date.parse("2026-03-08T05:00:00Z"))).toBe(Date.parse("2026-03-08T07:30:00Z"));
});

test("item commands persist, deduplicate, reject mismatched identities and protect stale edits", async () => {
  const f = await setup();
  const command = { action: "create" as const, requestId: "create", item: draft() };
  const first = await f.service.command(command);
  expect(await f.service.command(command)).toMatchObject({ id: first.id, duplicate: true });
  await expect(f.service.command({ ...command, item: draft("Different") })).rejects.toThrow("identity");
  const detail = await f.service.detail(first.id);
  expect(detail.item.revision).toBe(1); expect(detail.executions).toEqual([]);
  await f.service.command({ action: "update", requestId: "update", id: first.id, revision: 1, item: draft("Renamed") });
  await expect(f.service.command({ action: "update", requestId: "stale", id: first.id, revision: 1, item: draft("Stale") })).rejects.toThrow("changed");
  await f.runtime.dispose();
  const restored = await f.createRuntime().workItems();
  expect((await restored.list()).map(item => item.title)).toEqual(["Renamed"]);
  expect(await new ItemFiles(f.paths.workspace).memory(first.id)).toContain("Item memory");
  expect(f.faux.state.callCount).toBe(0);
});

test("item executions share only item memory, save separate outputs, and return privately to the main agent", async () => {
  const f = await setup(); const created = await f.service.command({ action: "create", requestId: "create", item: draft() });
  const directory = new ItemFiles(f.paths.workspace).directory(created.id);
  await writeFile(join(directory, "MEMORY.md"), "The previous result was useful.\n");
  let workerCalls = 0; let reports = 0;
  const model: FauxResponseFactory = context => {
    if (!isWorker(context)) { reports++; expect(lastUser(context)).toContain(created.id); return fauxAssistantMessage(`Main summary ${reports}`); }
    const system = getCurrentSystemPrompt(context.messages);
    expect(system).toContain(directory); expect(system).toContain("The previous result was useful.");
    expect(getCurrentTools(context.messages).map(tool => tool.name)).not.toContain("work_item");
    expect(getCurrentTools(context.messages).map(tool => tool.name)).not.toContain("subagent");
    expect(context.messages.filter(message => message.role === "user")).toHaveLength(1);
    if (context.messages.findLast(message => message.role !== "system")?.role === "toolResult") return fauxAssistantMessage("Saved the report");
    if (workerCalls > 0) expect(system).toContain("Remembered finding from run 1");
    workerCalls++;
    const id = lastUser(context).match(/execution (\d+)\./)![1];
    return fauxAssistantMessage([
      fauxToolCall("write", { path: `outputs/${id}/report.md`, content: `# Report ${workerCalls}` }),
      fauxToolCall("write", { path: "MEMORY.md", content: `The previous result was useful.\nRemembered finding from run ${workerCalls}\n` }),
    ], { stopReason: "toolUse" });
  };
  f.faux.setResponses(Array.from({ length: 16 }, () => model));
  const first = await f.service.command({ action: "run", requestId: "run-one", id: created.id });
  expect((await f.service.command({ action: "run", requestId: "run-one", id: created.id })).executionId).toBe(first.executionId);
  await waitUntil(() => reports === 1);
  await f.session.native.waitForIdle(ctx);
  const second = await f.service.command({ action: "run", requestId: "run-two", id: created.id });
  await waitUntil(() => reports === 2);
  expect(first.executionId).not.toBe(second.executionId);
  expect((await f.service.detail(created.id)).executions.map(value => value.status)).toEqual(["completed", "completed"]);
  expect(await readFile(join(directory, "outputs", first.executionId!, "report.md"), "utf8")).toBe("# Report 1");
  expect(await readFile(join(directory, "outputs", second.executionId!, "report.md"), "utf8")).toBe("# Report 2");
  expect(await readFile(join(directory, "MEMORY.md"), "utf8")).toContain("Remembered finding from run 2");
  await f.session.native.waitForIdle(ctx);
  const messages = (await f.session.snapshot()).messages;
  expect(messages.filter(value => value.role === "user")).toHaveLength(0);
  expect(messages.map(value => value.content)).toEqual(["Main summary 1", "Main summary 2"]);
}, 15000);

test("an overdue once schedule is admitted once and renaming or restarting does not rearm it", async () => {
  const f = await setup(); f.faux.setResponses(Array.from({ length: 12 }, () => route));
  const item = { ...draft(), schedule: { type: "once" as const, at: Date.now() - 1000 } };
  const created = await f.service.command({ action: "create", requestId: "create", item });
  await Promise.all([f.service.tick(), f.service.tick()]);
  await waitUntil(async () => (await f.service.detail(created.id)).executions[0]?.status === "completed");
  await waitUntil(async () => (await f.session.snapshot()).messages.some(value => value.content === "Main summary"));
  expect((await f.service.detail(created.id)).item.nextDueAt).toBeNull();
  await f.service.command({ action: "update", id: created.id, requestId: "rename", revision: 1, item: { ...item, title: "Renamed", prompt: "Different future prompt" } });
  await f.service.tick(); expect((await f.service.detail(created.id)).executions).toHaveLength(1);
  await f.runtime.dispose(); const restored = await f.createRuntime().workItems(); await restored.list();
  expect((await restored.detail(created.id)).executions).toHaveLength(1);
  expect((await restored.detail(created.id)).item.nextDueAt).toBeNull();
}, 15000);

test("a completed one-off archives itself while a failed one stays active", async () => {
  const f = await setup();
  f.faux.setResponses(Array.from({ length: 20 }, () => context => {
    if (!isWorker(context)) return fauxAssistantMessage("Acknowledged");
    if (lastUser(context).includes("Fails")) throw new Error("Research failed");
    return fauxAssistantMessage("Done");
  }));
  const at = Date.now() - 1000;
  const works = await f.service.command({ action: "create", requestId: "works", item: { ...draft("Works"), schedule: { type: "once", at } } });
  const fails = await f.service.command({ action: "create", requestId: "fails", item: { ...draft("Fails"), schedule: { type: "once", at } } });
  await f.service.tick();
  await waitUntil(async () => (await f.service.detail(works.id)).executions[0]?.status === "completed");
  await waitUntil(async () => (await f.service.detail(fails.id)).executions[0]?.status === "failed");
  await f.service.tick();
  const worksItem = (await f.service.detail(works.id)).item;
  expect(worksItem.status).toBe("archived");
  expect((await f.service.detail(fails.id)).item.status).toBe("active");
  // Restoring a finished one-off must not be undone by the next scheduler tick.
  await f.service.command({ action: "status", requestId: "restore", id: works.id, revision: worksItem.revision, status: "active" });
  await f.service.tick();
  expect((await f.service.detail(works.id)).item.status).toBe("active");
}, 15000);

test("cron coalesces missed occurrences and skips overlap while a run is active", async () => {
  const f = await setup(); const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>(); cleanup(() => gate.resolve());
  f.faux.setResponses(Array.from({ length: 16 }, () => async context => {
    if (isWorker(context)) { entered.resolve(); await gate.promise; return fauxAssistantMessage("Done"); }
    return fauxAssistantMessage("Main summary");
  }));
  const rule = { type: "cron" as const, expression: "* * * * *", timezone: "UTC" };
  const created = await f.service.command({ action: "create", requestId: "create", item: { ...draft(), schedule: rule } });
  await f.session.nativeHarness.commit(async tx => { (await tx.doc(WorkItems, ROOT_CONVERSATION_ID)).items[0].nextDueAt = Date.now() - 3_600_000; }, ctx);
  await f.service.tick(); await entered.promise;
  let detail = await f.service.detail(created.id);
  expect(detail.executions).toHaveLength(1); expect(detail.executions[0].scheduledAt).toBe(latestDue(rule, detail.executions[0].startedAt));
  await expect(f.service.command({ action: "run", requestId: "duplicate-work", id: created.id })).rejects.toThrow("already running");
  await f.session.nativeHarness.commit(async tx => { (await tx.doc(WorkItems, ROOT_CONVERSATION_ID)).items[0].nextDueAt = Date.now() - 1; }, ctx);
  await f.service.tick(); detail = await f.service.detail(created.id);
  expect(detail.executions).toHaveLength(1); expect(detail.item.nextDueAt!).toBeGreaterThan(Date.now());
  gate.resolve(); await waitUntil(async () => (await f.service.detail(created.id)).executions[0].status === "completed");
  await f.service.command({ action: "run", requestId: "manual-run", id: created.id });
  expect((await f.service.detail(created.id)).executions).toHaveLength(2);
}, 15000);

test("stop identities target the original execution and cannot cancel a later run", async () => {
  const f = await setup(); const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>(); cleanup(() => gate.resolve());
  let calls = 0;
  f.faux.setResponses(Array.from({ length: 16 }, () => async (context, options) => {
    if (isWorker(context)) {
      calls++; if (calls === 1) { entered.resolve(); options?.signal?.addEventListener("abort", () => gate.resolve(), { once: true }); await gate.promise; }
      return fauxAssistantMessage("Finished");
    }
    return fauxAssistantMessage("Main summary");
  }));
  const created = await f.service.command({ action: "create", requestId: "create", item: draft() });
  const first = await f.service.command({ action: "run", requestId: "first", id: created.id }); await entered.promise;
  await expect(f.service.command({ action: "status", requestId: "archive-running", id: created.id, revision: 1, status: "archived" })).rejects.toThrow("Stop");
  const stop = { action: "stop" as const, requestId: "stop", id: created.id, executionId: first.executionId! };
  await f.service.command(stop);
  expect((await f.service.detail(created.id)).executions[0].status).toBe("stopped");
  const second = await f.service.command({ action: "run", requestId: "second", id: created.id });
  expect((await f.service.command(stop)).duplicate).toBe(true);
  await waitUntil(async () => (await f.service.result(created.id, second.executionId!)).execution.status === "completed");
  expect((await f.service.detail(created.id)).executions[1].status).toBe("stopped");
}, 15000);

test("restart marks uncertain item work interrupted, preserves item cwd and does not replay a once trigger", async () => {
  const f = await setup(); const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>(); cleanup(() => gate.resolve());
  f.faux.setResponses(Array.from({ length: 12 }, () => async (context, options) => {
    if (isWorker(context)) { entered.resolve(); options?.signal?.addEventListener("abort", () => gate.resolve(), { once: true }); await gate.promise; return fauxAssistantMessage("Uncertain"); }
    return fauxAssistantMessage("Main summary");
  }));
  const created = await f.service.command({ action: "create", requestId: "create", item: { ...draft(), schedule: { type: "once", at: Date.now() - 1 } } });
  await f.service.tick(); await entered.promise;
  const child = (await f.service.detail(created.id)).executions[0].id;
  await f.runtime.dispose(); const calls = f.faux.state.callCount;
  const runtime = f.createRuntime(); const session = await runtime.createSession(); const service = session.workItems(); await service.tick();
  // Abort intents are prepared before resume; native abort handlers then release LiveDoc/tool ownership.
  await waitUntil(async () => (await service.detail(created.id)).executions[0].status === "interrupted");
  expect(f.faux.state.callCount).toBe(calls);
  expect((await service.detail(created.id)).executions).toMatchObject([{ status: "interrupted" }]);
  const id = Number(child) as typeof session.native.id;
  expect((await (await session.nativeHarness.conversation(id, ctx))!.agent(ctx)).cwd).toBe(new ItemFiles(f.paths.workspace).directory(created.id));
  expect((await session.nativeHarness.snapshot(ItemContext, id, ctx))?.binding?.interrupted).toBe(true);
}, 15000);

test("a failed child is shown as failed even when its reporter successfully returns the error", async () => {
  const f = await setup(); f.faux.setResponses(Array.from({ length: 12 }, () => context => {
    if (isWorker(context)) throw new Error("Research failed");
    return fauxAssistantMessage("Failure explained");
  }));
  const created = await f.service.command({ action: "create", requestId: "create", item: draft() });
  const run = await f.service.command({ action: "run", requestId: "run", id: created.id });
  await waitUntil(async () => (await f.service.result(created.id, run.executionId!)).execution.status === "failed");
  await waitUntil(async () => (await f.session.snapshot()).messages.some(value => value.content === "Failure explained"));
  expect((await f.service.result(created.id, run.executionId!)).execution.error).toBeTruthy();
}, 15000);

test("item directories refuse to follow symlinks and cross-item executions stay isolated", async () => {
  const f = await setup(); f.faux.setResponses(Array.from({ length: 8 }, () => route));
  const created = await f.service.command({ action: "create", requestId: "create", item: draft() });
  const other = await f.service.command({ action: "create", requestId: "other", item: draft("Other") });
  const run = await f.service.command({ action: "run", requestId: "run", id: created.id });
  await waitUntil(async () => (await f.service.result(created.id, run.executionId!)).execution.status === "completed");
  const files = new ItemFiles(f.paths.workspace);
  await expect(f.service.result(other.id, run.executionId!)).rejects.toThrow("not found");
  const outside = join(f.root, "outside"); await mkdir(outside); await symlink(outside, join(f.paths.workspace, "items", "unsafe"));
  await expect(files.prepare("unsafe")).rejects.toThrow("Symbolic");
}, 15000);

test("HTTP endpoints validate commands, separate receipts from results, and expose no alternate workspace", async () => {
  const f = await setup(); const store = new ConversationStore(f.runtime); cleanup(() => store.close());
  const app = createApp({ runtime: f.runtime, conversations: store, config: defaultServerConfig() });
  const post = (value: unknown) => app(new Request("http://local/api/items", { method: "POST", body: JSON.stringify(value) }));
  expect((await post({ action: "create", requestId: "piko:forged", item: draft() })).status).toBe(422);
  expect((await post({ action: "create", requestId: "bad-cron", item: { ...draft(), schedule: { type: "cron", expression: "bad", timezone: "UTC" } } })).status).toBe(422);
  const result = await (await post({ action: "create", requestId: "create", item: draft() })).json();
  expect(result.id).toBeString(); expect(result.duplicate).toBe(false);
  expect((await (await app(new Request("http://local/api/items"))).json()).items).toHaveLength(1);
  const detail = await (await app(new Request(`http://local/api/items/${result.id}`))).json();
  expect(detail.item.title).toBe("Daily research"); expect(detail.item.source).toBeUndefined();
  expect((await post({ action: "status", requestId: "pause", id: result.id, status: "paused" })).status).toBe(422);
  expect((await app(new Request("http://local/api/items/missing"))).status).toBe(404);
  expect(f.faux.state.callCount).toBe(0);
});

test("global item capacity holds overdue once work until an execution slot is available", async () => {
  const f = await setup(); const gate = Promise.withResolvers<void>(); cleanup(() => gate.resolve());
  let workers = 0;
  f.faux.setResponses(Array.from({ length: 20 }, () => async context => {
    if (isWorker(context)) { workers++; await gate.promise; return fauxAssistantMessage("Done"); }
    return fauxAssistantMessage("Main summary");
  }));
  const first = await f.service.command({ action: "create", requestId: "first-item", item: draft("First") });
  const second = await f.service.command({ action: "create", requestId: "second-item", item: draft("Second") });
  await f.service.command({ action: "run", requestId: "first-run", id: first.id });
  await f.service.command({ action: "run", requestId: "second-run", id: second.id });
  await waitUntil(() => workers === 2);
  const third = await f.service.command({ action: "create", requestId: "third-item", item: { ...draft("Third"), schedule: { type: "once", at: Date.now() - 1 } } });
  await expect(f.service.command({ action: "run", requestId: "third-run", id: third.id })).rejects.toThrow("Two items");
  await f.service.tick(); expect((await f.service.detail(third.id)).executions).toHaveLength(0);
  expect((await f.service.detail(third.id)).item.nextDueAt).not.toBeNull();
  gate.resolve();
  await waitUntil(async () => (await f.service.list()).filter(item => item.latest?.status === "completed").length >= 2);
  await f.service.tick(); await waitUntil(() => workers === 3);
  expect((await f.service.detail(third.id)).executions).toHaveLength(1);
  expect((await f.service.detail(third.id)).item.nextDueAt).toBeNull();
}, 15000);
