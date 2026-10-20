import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { buildMemoryCurationPrompt, localDate, redactMemorySecrets } from "../server/domain/memory-curation";
import { MEMORY_CURATION_IDLE_MS, MEMORY_CURATION_KIND, MemoryCurationDoc, MemoryCurationService, memoryCurationIsDue } from "../server/runtime/memory-curation";
import { fixture, waitUntil } from "./fixtures/durable";

const isCurator = (input: Parameters<FauxResponseFactory>[0]) => getCurrentSystemPrompt(input.messages).includes("You are Piko's memory curator.");
const curatorTools = ["edit", "read", "write"];

test("memory review waits for thirty minutes of idle", () => {
  const now = 100 * 60_000;
  expect(MEMORY_CURATION_IDLE_MS).toBe(30 * 60_000);
  expect(memoryCurationIsDue(now - MEMORY_CURATION_IDLE_MS + 1, now, false, null)).toBe(false);
  expect(memoryCurationIsDue(now - MEMORY_CURATION_IDLE_MS, now, false, null)).toBe(true);
  expect(memoryCurationIsDue(now - MEMORY_CURATION_IDLE_MS, now, true, null)).toBe(false);
  expect(memoryCurationIsDue(now - MEMORY_CURATION_IDLE_MS, now, false, now + 1)).toBe(false);
});

test("memory dates use the selected timezone and common credential patterns are redacted", () => {
  expect(localDate(Date.parse("2026-10-20T16:30:00Z"), "Asia/Shanghai")).toBe("2026-10-21");
  const secret = `sk-${"X".repeat(28)}`;
  expect(redactMemorySecrets(`api_key=${secret}`)).not.toContain(secret);
});

test("the curation prompt carries the memory budget and write boundaries", () => {
  const prompt = buildMemoryCurationPrompt([{ role: "user", date: "2026-10-20", content: "hi" }], { bytes: 1234 });
  expect(prompt).toContain("1234 of 4000 bytes");
  expect(prompt).toContain("Never rewrite existing lines");
  expect(prompt).toContain("A fact lives in one place");
});

test("the idle scheduler waits, curates after the idle threshold, and skips the model when no entries remain", async () => {
  const f = await fixture(); const session = await f.createSession(); let curationTurns = 0;
  const route: FauxResponseFactory = input => {
    if (isCurator(input)) { curationTurns++; return fauxAssistantMessage("No durable memory changes."); }
    expect(getCurrentTools(input.messages).map(tool => tool.name)).not.toContain("memory_review");
    return fauxAssistantMessage("Conversation finished.");
  };
  f.faux.setResponses(Array.from({ length: 8 }, () => route));
  await session.prompt("We discussed a useful topic.", { id: "idle-review-test", createdAt: Date.now() });
  const service = (session as unknown as { memoryCurationService: MemoryCurationService }).memoryCurationService;
  await session.nativeHarness.commit(async tx => { (await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID)).idleSince = Date.now(); }, ctx);
  expect(await service.tick()).toBe("nothing-new");
  expect(curationTurns).toBe(0);
  await session.nativeHarness.commit(async tx => { (await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID)).idleSince = Date.now() - MEMORY_CURATION_IDLE_MS; }, ctx);
  expect(await service.tick()).toBe("started");
  await waitUntil(async () => {
    const state = await session.nativeHarness.commit(async tx => {
      const value = await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID);
      return { cursor: value.cursor, activeTaskId: value.activeTaskId };
    }, ctx);
    return state.cursor > 0 && state.activeTaskId === null;
  });
  expect(curationTurns).toBe(1);
  expect(await service.tick()).toBe("nothing-new");
  expect(curationTurns).toBe(1);
}, 15000);

test("silent background curation directly edits both memory files; the main Agent has no trigger tool", async () => {
  const f = await fixture(); const today = localDate(Date.now(), "Asia/Shanghai");
  await writeFile(join(f.paths.workspace, "MEMORY.md"), "# Existing memory\n\n- Existing stable fact.\n");
  await writeFile(join(f.paths.workspace, "memory", `${today}.md`), `# ${today}\n\n- Earlier daily note.\n`);
  const session = await f.createSession(); let curationTurns = 0;
  const route: FauxResponseFactory = input => {
    if (isCurator(input)) {
      curationTurns++;
      expect(getCurrentTools(input.messages).map(tool => tool.name).sort()).toEqual(curatorTools);
      if (curationTurns === 1) return fauxAssistantMessage([
        fauxToolCall("read", { path: "MEMORY.md" }),
        fauxToolCall("read", { path: `memory/${today}.md` }),
      ], { stopReason: "toolUse" });
      if (curationTurns === 2) {
        const readResults = JSON.stringify(input.messages.filter(message => message.role === "toolResult"));
        expect(readResults).toContain("Existing stable fact."); expect(readResults).toContain("Earlier daily note.");
        return fauxAssistantMessage([
          fauxToolCall("edit", { path: "MEMORY.md", edits: [{ oldText: "Existing stable fact.", newText: "Existing stable fact.\n- Dand prefers concise Chinese replies." }] }),
          fauxToolCall("edit", { path: `memory/${today}.md`, edits: [{ oldText: "Earlier daily note.", newText: "Earlier daily note.\n- Dand prefers concise Chinese replies." }] }),
        ], { stopReason: "toolUse" });
      }
      expect(curationTurns).toBe(3);
      return fauxAssistantMessage("Updated both memory files.");
    }
    expect(getCurrentTools(input.messages).map(tool => tool.name)).not.toContain("memory_review");
    return fauxAssistantMessage("Conversation finished.");
  };
  f.faux.setResponses(Array.from({ length: 16 }, () => route));
  await session.prompt("We discussed that I prefer concise Chinese replies.", { id: "memory-curation-test", createdAt: Date.now() });
  const service = (session as unknown as { memoryCurationService: MemoryCurationService }).memoryCurationService;
  await session.nativeHarness.commit(async tx => { (await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID)).idleSince = Date.now() - MEMORY_CURATION_IDLE_MS; }, ctx);
  expect(await service.tick()).toBe("started");

  await waitUntil(async () => {
    const state = await session.nativeHarness.commit(async tx => {
      const value = await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID);
      return { cursor: value.cursor, activeTaskId: value.activeTaskId };
    }, ctx);
    return state.cursor > 0 && state.activeTaskId === null;
  });
  const daily = await readFile(join(f.paths.workspace, "memory", `${today}.md`), "utf8");
  const longTerm = await readFile(join(f.paths.workspace, "MEMORY.md"), "utf8");
  expect(daily).toContain("Earlier daily note."); expect(daily).toContain("Dand prefers concise Chinese replies.");
  expect(longTerm).toContain("Existing stable fact."); expect(longTerm).toContain("Dand prefers concise Chinese replies.");
  expect(curationTurns).toBe(3);
  expect(session.messages.map(message => message.content)).toEqual(["We discussed that I prefer concise Chinese replies.", "Conversation finished."]);
  const records = await session.nativeHarness.commit(async tx => (await tx.scanTasks({ conversationId: ROOT_CONVERSATION_ID, kind: MEMORY_CURATION_KIND }, 20)).items, ctx);
  expect(records).toHaveLength(1); expect(records[0]?.state.outcome?.status).toBe("completed");
  expect(await session.workItems().list()).toHaveLength(0);
}, 15000);

test("restart cancels uncertain curation without replay; the idle scheduler can retry its source range", async () => {
  const f = await fixture(); const today = localDate(Date.now(), "Asia/Shanghai");
  const session = await f.createSession(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  let curationTurns = 0;
  const route: FauxResponseFactory = async (input, options) => {
    if (isCurator(input)) {
      curationTurns++;
      expect(getCurrentTools(input.messages).map(tool => tool.name).sort()).toEqual(curatorTools);
      if (curationTurns === 1) {
        entered.resolve();
        options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
        await release.promise;
        return fauxAssistantMessage("Interrupted review.");
      }
      if (curationTurns === 2) return fauxAssistantMessage(fauxToolCall("read", { path: `memory/${today}.md` }), { stopReason: "toolUse" });
      if (curationTurns === 3) return fauxAssistantMessage(fauxToolCall("write", { path: `memory/${today}.md`, content: `# ${today}\n\n- Recovered from the original durable conversation.\n` }), { stopReason: "toolUse" });
      return fauxAssistantMessage("Updated the daily memory.");
    }
    expect(getCurrentTools(input.messages).map(tool => tool.name)).not.toContain("memory_review");
    return fauxAssistantMessage("Conversation finished.");
  };
  f.faux.setResponses(Array.from({ length: 20 }, () => route));
  await session.prompt("We discussed a durable preference.", { id: "memory-curation-restart", createdAt: Date.now() });
  const service = (session as unknown as { memoryCurationService: MemoryCurationService }).memoryCurationService;
  await session.nativeHarness.commit(async tx => { (await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID)).idleSince = Date.now() - MEMORY_CURATION_IDLE_MS; }, ctx);
  expect(await service.tick()).toBe("started");
  await entered.promise;
  await f.runtime.dispose();
  expect(curationTurns).toBe(1);

  const restartedRuntime = f.createRuntime(); const restarted = await restartedRuntime.createSession();
  await Bun.sleep(100);
  expect(curationTurns).toBe(1); // Startup aborts uncertain work; it does not rerun the model.
  const restartedService = (restarted as unknown as { memoryCurationService: MemoryCurationService }).memoryCurationService;
  let trigger: "started" | "nothing-new" = "nothing-new";
  await waitUntil(async () => {
    await restarted.nativeHarness.commit(async tx => {
      const state = await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID);
      state.idleSince = Date.now() - MEMORY_CURATION_IDLE_MS; state.retryAfter = Date.now() - 1;
    }, ctx);
    trigger = await restartedService.tick();
    return trigger === "started";
  });
  await waitUntil(async () => {
    const state = await restarted.nativeHarness.commit(async tx => {
      const value = await tx.doc(MemoryCurationDoc, ROOT_CONVERSATION_ID);
      return { cursor: value.cursor, activeTaskId: value.activeTaskId };
    }, ctx);
    return state.cursor > 0 && state.activeTaskId === null;
  });
  expect(curationTurns).toBe(4);
  expect(await readFile(join(f.paths.workspace, "memory", `${today}.md`), "utf8")).toContain("Recovered from the original durable conversation.");
}, 20000);
