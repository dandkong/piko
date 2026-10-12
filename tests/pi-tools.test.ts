import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { fixture } from "./fixtures/durable";
import { DurableChatSession } from "../server/runtime/pi";
import { applyMessageEvent } from "../shared/messages";
import type { Message } from "../shared/chat";
import type { SessionEvent } from "../server/runtime/types";

test("durable runs coding tools, refreshes skills, and persists native tool results", async () => {
  const f = await fixture(); const session = await f.createSession();
  const events: SessionEvent[] = []; session.subscribe(event => events.push(event));
  f.faux.setResponses([
    context => {
      expect(getCurrentTools(context.messages).map(tool => tool.name).sort()).toEqual(["bash", "edit", "read", "subagent", "write"]);
      expect(getCurrentSystemPrompt(context.messages)).toContain("<available_skills>");
      return fauxAssistantMessage([
        fauxToolCall("write", { path: "artifacts/probe.txt", content: "hello from Piko" }),
        fauxToolCall("edit", { path: "artifacts/probe.txt", edits: [{ oldText: "hello", newText: "updated" }] }),
        fauxToolCall("read", { path: "artifacts/probe.txt" }),
        fauxToolCall("write", { path: ".agents/skills/new-skill/SKILL.md", content: "---\nname: new-skill\ndescription: A test user skill\n---\nRead this body.\n" }),
        fauxToolCall("read", { path: ".agents/skills/new-skill/SKILL.md" }),
        fauxToolCall("bash", { command: "printf 'piko-bash-working'", timeout: 10 }),
      ], { stopReason: "toolUse" });
    },
    context => {
      const results = context.messages.filter(message => message.role === "toolResult");
      expect(results).toHaveLength(6);
      expect(results.every(result => !result.isError)).toBe(true);
      expect(JSON.stringify(results)).toContain("piko-bash-working");
      expect(getCurrentSystemPrompt(context.messages)).toContain("new-skill");
      return fauxAssistantMessage("Saved.");
    },
  ]);
  const run = { id: crypto.randomUUID(), createdAt: Date.now() };
  await session.prompt("Save a reusable skill", run);
  expect(await readFile(join(f.paths.workspace, "artifacts/probe.txt"), "utf8")).toBe("updated from Piko");
  expect(events.filter(event => event.type === "message").reduce((items: Message[], event) => applyMessageEvent(items, event), []).map(message => message.content).join("")).toBe("Saved.");
  expect((await f.runtime.readHistory()).messages.map(message => message.content)).toEqual(["Save a reusable skill", "Saved."]);
  await session.dispose();
  expect((await f.runtime.readHistory()).messages).toHaveLength(2);
});

test("literal submissions, multiple turns and passive results survive restart without duplicate streaming", async () => {
  const f = await fixture(); const session = await f.createSession() as DurableChatSession;
  const events: SessionEvent[] = []; session.subscribe(event => events.push(event));
  f.faux.setResponses([
    fauxAssistantMessage([{ type: "text", text: "Checking. " }, fauxToolCall("read", { path: "MEMORY.md" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
    context => { expect(JSON.stringify(context.messages)).toContain("scheduled summary"); return fauxAssistantMessage("Explanation."); },
  ]);
  const run = { id: crypto.randomUUID(), createdAt: 1 };
  await session.prompt("/skill:piko-workspace", run);
  expect(events.filter(event => event.type === "message").reduce((items: Message[], event) => applyMessageEvent(items, event), []).map(message => message.content).join("")).toBe("Checking. Done.");
  expect(events.filter(event => event.type === "message").filter(event => event.final).map(event => event.message.content)).toEqual(["Checking. ", "Done."]);
  await session.prompt("/skill:piko-workspace", run);
  expect(f.faux.state.callCount).toBe(2);
  await session.native.commit(tx => tx.appendEntry(session.native.id, { kind: "piko.result", data: { display: true, createdAt: 3 },
    model: [{ role: "user", content: "scheduled summary", timestamp: 3 }] }), ctx);
  expect(f.faux.state.callCount).toBe(2);
  await session.prompt("explain", { id: crypto.randomUUID(), createdAt: 4 });
  const saved = await f.runtime.readHistory();
  expect(saved.messages.find(message => message.requestId === run.id)?.content).toBe("/skill:piko-workspace");
  expect(saved.messages.map(message => message.content)).toEqual(["/skill:piko-workspace", "Checking. ", "Done.", "scheduled summary", "explain", "Explanation."]);
  await session.dispose();
  expect((await f.runtime.readHistory()).messages).toEqual(saved.messages);
});

test("provider failure surfaces, abort stops work, and next input still works", async () => {
  const f = await fixture(30);
  f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" })]);
  await writeFile(join(f.paths.home, "config/settings.json"), JSON.stringify({ version: 1, retry: { enabled: false } }));
  const session = await f.createSession();
  await expect(session.prompt("fail", { id: crypto.randomUUID(), createdAt: 1 })).rejects.toThrow();
  const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>();
  f.faux.setResponses([async () => { entered.resolve(); await gate.promise; return fauxAssistantMessage("Interrupted reply."); }, fauxAssistantMessage("Next.")]);
  const pending = session.prompt("stop", { id: crypto.randomUUID(), createdAt: 2 });
  void pending.catch(() => {});
  await entered.promise; const stopped = session.abort(); gate.resolve(); await stopped;
  await expect(pending).rejects.toThrow("Reply stopped.");
  expect(session.isStreaming).toBe(false);
  await session.prompt("next", { id: crypto.randomUUID(), createdAt: 3 });
  expect(session.messages.at(-1)?.content).toBe("Next.");
});
