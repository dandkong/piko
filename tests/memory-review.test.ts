import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { localDate, redactMemorySecrets } from "../server/domain/memory-review";
import { MEMORY_REVIEW_IDLE_MS, MEMORY_REVIEW_KIND, MemoryReviewDoc, MemoryReviewService, memoryReviewIsDue } from "../server/runtime/memory-review";
import { fixture, waitUntil } from "./fixtures/durable";

function latestUser(context: Parameters<FauxResponseFactory>[0]): string {
  const user = context.messages.findLast(message => message.role === "user");
  return typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "");
}
const isReviewer = (context: Parameters<FauxResponseFactory>[0]) => getCurrentSystemPrompt(context.messages).includes("You are Piko's private memory reviewer.");
const reviewerTools = ["bash", "edit", "read", "write"];

test("memory review waits for thirty minutes of idle, unless explicitly forced", () => {
  const now = 100 * 60_000;
  expect(MEMORY_REVIEW_IDLE_MS).toBe(30 * 60_000);
  expect(memoryReviewIsDue(now - MEMORY_REVIEW_IDLE_MS + 1, now, false, null)).toBe(false);
  expect(memoryReviewIsDue(now - MEMORY_REVIEW_IDLE_MS, now, false, null)).toBe(true);
  expect(memoryReviewIsDue(now - MEMORY_REVIEW_IDLE_MS, now, true, null)).toBe(false);
  expect(memoryReviewIsDue(now - MEMORY_REVIEW_IDLE_MS, now, false, now + 1)).toBe(false);
  expect(memoryReviewIsDue(null, now, true, now + 1, true)).toBe(true);
});

test("memory dates use the selected timezone and common credential patterns are redacted", () => {
  expect(localDate(Date.parse("2026-10-20T16:30:00Z"), "Asia/Shanghai")).toBe("2026-10-21");
  const secret = `sk-${"X".repeat(28)}`;
  expect(redactMemorySecrets(`api_key=${secret}`)).not.toContain(secret);
});

test("the idle scheduler waits, reviews after the idle threshold, and skips the model when no entries remain", async () => {
  const f = await fixture(); const session = await f.createSession(); let reviewTurns = 0;
  const route: FauxResponseFactory = context => {
    if (isReviewer(context)) { reviewTurns++; return fauxAssistantMessage("No durable memory changes."); }
    return fauxAssistantMessage("Conversation finished.");
  };
  f.faux.setResponses(Array.from({ length: 8 }, () => route));
  await session.prompt("We discussed a useful topic.", { id: "idle-review-test", createdAt: Date.now() });
  const service = (session as unknown as { memoryReviewService: MemoryReviewService }).memoryReviewService;
  await session.nativeHarness.commit(async tx => { (await tx.doc(MemoryReviewDoc, ROOT_CONVERSATION_ID)).idleSince = Date.now(); }, ctx);
  expect(await service.tick()).toBe("nothing-new");
  expect(reviewTurns).toBe(0);
  await session.nativeHarness.commit(async tx => { (await tx.doc(MemoryReviewDoc, ROOT_CONVERSATION_ID)).idleSince = Date.now() - MEMORY_REVIEW_IDLE_MS; }, ctx);
  expect(await service.tick()).toBe("started");
  await waitUntil(async () => {
    const state = await session.nativeHarness.commit(async tx => {
      const value = await tx.doc(MemoryReviewDoc, ROOT_CONVERSATION_ID);
      return { cursor: value.cursor, activeTaskId: value.activeTaskId };
    }, ctx);
    return state.cursor > 0 && state.activeTaskId === null;
  });
  expect(reviewTurns).toBe(1);
  expect(await service.runNow()).toBe("nothing-new");
  expect(reviewTurns).toBe(1);
}, 15000);

test("one explicit Review receives exactly four workspace tools and edits both memory files itself", async () => {
  const f = await fixture(); const today = localDate(Date.now(), "Asia/Shanghai");
  await writeFile(join(f.paths.workspace, "MEMORY.md"), "# Existing memory\n\n- Existing stable fact.\n");
  await writeFile(join(f.paths.workspace, "memory", `${today}.md`), `# ${today}\n\n- Earlier daily note.\n`);
  const session = await f.createSession(); let reviewTurns = 0; let mainTurns = 0;
  const route: FauxResponseFactory = context => {
    if (isReviewer(context)) {
      reviewTurns++;
      expect(getCurrentTools(context.messages).map(tool => tool.name).sort()).toEqual(reviewerTools);
      if (reviewTurns === 1) return fauxAssistantMessage([
        fauxToolCall("read", { path: "MEMORY.md" }),
        fauxToolCall("read", { path: `memory/${today}.md` }),
      ], { stopReason: "toolUse" });
      if (reviewTurns === 2) {
        const readResults = JSON.stringify(context.messages.filter(message => message.role === "toolResult"));
        expect(readResults).toContain("Existing stable fact."); expect(readResults).toContain("Earlier daily note.");
        return fauxAssistantMessage([
          fauxToolCall("edit", { path: "MEMORY.md", edits: [{ oldText: "Existing stable fact.", newText: "Existing stable fact.\n- Dand prefers concise Chinese replies." }] }),
          fauxToolCall("edit", { path: `memory/${today}.md`, edits: [{ oldText: "Earlier daily note.", newText: "Earlier daily note.\n- Dand prefers concise Chinese replies." }] }),
        ], { stopReason: "toolUse" });
      }
      expect(reviewTurns).toBe(3);
      return fauxAssistantMessage("Updated both memory files.");
    }
    mainTurns++;
    if (context.messages.findLast(message => message.role !== "system")?.role === "toolResult") return fauxAssistantMessage("已记住这个偏好。");
    if (latestUser(context).includes("请记住") && getCurrentTools(context.messages).some(tool => tool.name === "memory_review")) {
      return fauxAssistantMessage(fauxToolCall("memory_review", {}), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("好的。");
  };
  f.faux.setResponses(Array.from({ length: 16 }, () => route));
  await session.prompt("请记住：我偏好简洁的中文回答。", { id: "memory-review-test", createdAt: Date.now() });

  await waitUntil(async () => {
    const state = await session.nativeHarness.commit(async tx => {
      const value = await tx.doc(MemoryReviewDoc, ROOT_CONVERSATION_ID);
      return { cursor: value.cursor, activeTaskId: value.activeTaskId };
    }, ctx);
    return state.cursor > 0 && state.activeTaskId === null;
  });
  const daily = await readFile(join(f.paths.workspace, "memory", `${today}.md`), "utf8");
  const longTerm = await readFile(join(f.paths.workspace, "MEMORY.md"), "utf8");
  expect(daily).toContain("Earlier daily note."); expect(daily).toContain("Dand prefers concise Chinese replies.");
  expect(longTerm).toContain("Existing stable fact."); expect(longTerm).toContain("Dand prefers concise Chinese replies.");
  expect(reviewTurns).toBe(3); expect(mainTurns).toBe(2);
  expect(session.messages.map(message => message.content)).toContain("已记住这个偏好。");
  expect(session.messages.map(message => message.content).join("\n")).not.toContain("Dand prefers concise Chinese replies.");
  const records = await session.nativeHarness.commit(async tx => (await tx.scanTasks({ conversationId: ROOT_CONVERSATION_ID, kind: MEMORY_REVIEW_KIND }, 20)).items, ctx);
  expect(records).toHaveLength(1); expect(records[0]?.state.outcome?.status).toBe("completed");
  expect(await session.workItems().list()).toHaveLength(0);
}, 15000);

test("restart cancels an uncertain memory review without replay; explicit retry edits the original range", async () => {
  const f = await fixture(); const today = localDate(Date.now(), "Asia/Shanghai");
  const session = await f.createSession(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  let reviewTurns = 0; let providerAborted = false;
  const route: FauxResponseFactory = async (context, options) => {
    if (isReviewer(context)) {
      reviewTurns++;
      expect(getCurrentTools(context.messages).map(tool => tool.name).sort()).toEqual(reviewerTools);
      if (reviewTurns === 1) {
        entered.resolve();
        options?.signal?.addEventListener("abort", () => { providerAborted = true; release.resolve(); }, { once: true });
        await release.promise;
        return fauxAssistantMessage("Interrupted review.");
      }
      if (reviewTurns === 2) return fauxAssistantMessage(fauxToolCall("read", { path: `memory/${today}.md` }), { stopReason: "toolUse" });
      if (reviewTurns === 3) return fauxAssistantMessage(fauxToolCall("write", { path: `memory/${today}.md`, content: `# ${today}\n\n- Recovered from the original durable conversation.\n` }), { stopReason: "toolUse" });
      return fauxAssistantMessage("Updated the daily memory.");
    }
    if (context.messages.findLast(message => message.role !== "system")?.role === "toolResult") return fauxAssistantMessage("Review queued.");
    if (latestUser(context).includes("请记住") && getCurrentTools(context.messages).some(tool => tool.name === "memory_review")) {
      return fauxAssistantMessage(fauxToolCall("memory_review", {}), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("好的。");
  };
  f.faux.setResponses(Array.from({ length: 20 }, () => route));
  await session.prompt("请记住：这条内容要在之后恢复 Review。", { id: "memory-review-restart", createdAt: Date.now() });
  await entered.promise;
  await f.runtime.dispose();
  expect(providerAborted).toBe(true); expect(reviewTurns).toBe(1);

  const restartedRuntime = f.createRuntime(); const restarted = await restartedRuntime.createSession();
  await Bun.sleep(100);
  expect(reviewTurns).toBe(1); // Startup aborts uncertain work; it does not rerun the model.
  const service = (restarted as unknown as { memoryReviewService: MemoryReviewService }).memoryReviewService;
  expect(await service.runNow()).toBe("started");
  await waitUntil(async () => {
    const state = await restarted.nativeHarness.commit(async tx => {
      const value = await tx.doc(MemoryReviewDoc, ROOT_CONVERSATION_ID);
      return { cursor: value.cursor, activeTaskId: value.activeTaskId };
    }, ctx);
    return state.cursor > 0 && state.activeTaskId === null;
  });
  expect(reviewTurns).toBe(4);
  expect(await readFile(join(f.paths.workspace, "memory", `${today}.md`), "utf8")).toContain("Recovered from the original durable conversation.");
}, 20000);
