import { expect, test } from "bun:test";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { UserEntry } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fixture } from "./fixtures/durable";
import { DurableChatSession } from "../server/runtime/pi";
import { loadWorkspaceResources, formatWorkspaceResources } from "../server/runtime/resources";
import { runtimePaths } from "../server/runtime/config/paths";
import { readPiEntries } from "../server/runtime/pi-history";

test("full UI history retains stable IDs after native context edits, reset and compaction", async () => {
  const f = await fixture(); const session = await f.createSession() as DurableChatSession;
  f.faux.setResponses([fauxAssistantMessage("old reply")]);
  await session.prompt("old input", { id: crypto.randomUUID(), createdAt: 1 });
  const old = await f.runtime.readHistory(f.input);
  const entries = await readPiEntries(session.nativeHarness);
  const user = entries.find(entry => entry.kind === "pi.user")!;
  await session.native.commit(tx => tx.appendEntry(session.native.id, { kind: "test.context-edit", edits: [{ target: user.id, action: "omit" }] }), ctx);
  expect(JSON.stringify((await session.native.context(ctx)).messages)).not.toContain("old input");
  await session.native.reset(undefined, ctx);
  expect(JSON.stringify((await session.native.context(ctx)).messages)).not.toContain("old reply");
  expect((await f.runtime.readHistory(f.input)).messages).toEqual(old.messages);
  const state = session.exportState(); await session.dispose();
  expect((await f.runtime.readHistory({ ...f.input, state })).messages).toEqual(old.messages);
});

test("history reads without credentials and fails closed for missing references, wrong identities and corrupt records", async () => {
  const f = await fixture();
  expect((await f.runtime.readHistory(f.input)).messages).toEqual([]);
  const session = await f.createSession() as DurableChatSession;
  await session.native.commit(tx => tx.appendEntry(UserEntry, session.native.id, {
    model: [{ role: "user", content: "saved before SQL", timestamp: 1 }] }), ctx);
  const state = session.exportState(); await session.dispose();
  await writeFile(join(f.paths.home, "config/auth.json"), "invalid credentials must not be read");
  expect((await f.runtime.readHistory(f.input)).messages[0]?.content).toBe("saved before SQL");
  await expect(f.runtime.readHistory({ ...f.input, state: { ...state, directory: crypto.randomUUID() } })).rejects.toThrow("reference");
  const path = join(runtimePaths(f.paths.home).sessions, f.input.threadId, "main.jsonl");
  const content = await readFile(path, "utf8");
  await appendFile(path, "{bad}\n");
  await expect(f.runtime.readHistory({ ...f.input, state })).rejects.toThrow();
  await writeFile(path, content); await unlink(path);
  await expect(f.runtime.readHistory({ ...f.input, state })).rejects.toThrow("missing");
});

test("workspace guidance and user-first YAML skills refresh without ancestor/global resources", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "AGENTS.md"), "ANCESTOR_MUST_NOT_LOAD");
  await writeFile(join(f.paths.workspace, "AGENTS.md"), "workspace instructions");
  await writeFile(join(f.paths.workspace, "AGENTS.override.md"), "override instructions");
  const skill = join(f.paths.workspace, ".agents/skills/piko-workspace"); await mkdir(skill);
  await writeFile(join(skill, "SKILL.md"), "---\nname: piko-workspace\ndescription: User replacement\n---\nUser body\n");
  const global = join(f.root, ".agents/skills/foreign"); await mkdir(global, { recursive: true });
  await writeFile(join(global, "SKILL.md"), "---\nname: foreign\ndescription: Must not load\n---\nForeign body\n");
  const bad = join(f.paths.workspace, ".agents/skills/bad"); await mkdir(bad);
  await writeFile(join(bad, "SKILL.md"), "---\nname: [invalid\n---\n");
  const resources = await loadWorkspaceResources(f.paths);
  expect(resources.skills.map(skill => skill.name)).toEqual(["piko-workspace"]);
  expect(resources.skills[0]?.description).toBe("User replacement");
  expect(resources.diagnostics.length).toBeGreaterThan(0);
  expect(formatWorkspaceResources(resources)).toContain("workspace instructions");
  expect(formatWorkspaceResources(resources)).not.toContain("override instructions");
  expect(formatWorkspaceResources(resources)).not.toContain("ANCESTOR_MUST_NOT_LOAD");
  await writeFile(join(f.paths.workspace, "USER.md"), "updated preference");
  expect(formatWorkspaceResources(await loadWorkspaceResources(f.paths))).toContain("updated preference");
});

test("manual compaction preserves full native UI history and restart does not call the model", async () => {
  const f = await fixture(); const session = await f.createSession();
  f.faux.setResponses([fauxAssistantMessage("old answer"), fauxAssistantMessage("recent answer")]);
  await session.prompt("Old context. ".repeat(10000), { id: crypto.randomUUID(), createdAt: 1 });
  await session.prompt("Recent context. ".repeat(6000), { id: crypto.randomUUID(), createdAt: 2 });
  const old = (await f.runtime.readHistory(f.input)).messages;
  f.faux.setResponses([fauxAssistantMessage("Compacted summary.")]);
  await f.runtime.compact!(f.input);
  expect(f.faux.state.callCount).toBe(3);
  expect((await f.runtime.readHistory(f.input)).messages).toEqual(old);
  const state = session.exportState!(); await session.dispose();
  const resumed = await f.runtime.createSession({ ...f.input, state });
  expect(resumed.messages).toEqual(old);
  expect(f.faux.state.callCount).toBe(3);
});

test("native JSONL recovery discards a torn tail and full history spans storage pages", async () => {
  const f = await fixture(); const session = await f.createSession() as DurableChatSession;
  await session.native.commit(async tx => {
    for (let index = 0; index < 510; index++) await tx.appendEntry(UserEntry, session.native.id, {
      model: [{ role: "user", content: `saved-${index}`, timestamp: index + 1 }] });
  }, ctx);
  const before = (await f.runtime.readHistory(f.input)).messages;
  expect(before).toHaveLength(510);
  const state = session.exportState(); await session.dispose();
  const path = join(runtimePaths(f.paths.home).sessions, f.input.threadId, "main.jsonl");
  await appendFile(path, '{"incomplete":');
  expect((await f.runtime.readHistory({ ...f.input, state })).messages).toEqual(before);
  expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  expect(f.faux.state.callCount).toBe(0);
});
