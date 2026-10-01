import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPiReference, openPiContext, readPiContext } from "../server/runtime/pi-context";
import { projectPiHistory } from "../server/runtime/pi-history";
import { createWorkspaceResources } from "../server/runtime/resources";
import { initializeWorkspace, resolveWorkspacePaths } from "../server/domain/workspace";
import { assistant } from "./fixtures/pi-message";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "piko-pi-test-")); roots.push(root);
  const paths = initializeWorkspace(resolveWorkspacePaths({ PIKO_HOME: root }));
  return { root, paths, directory: join(paths.state, "pi-sessions"), threadId: crypto.randomUUID(), interruptedRunIds: [] as string[] };
}

test("UI uses full native branch with stable entry IDs; compaction and model context edits do not erase displayed history", () => {
  const f = fixture(); const manager = openPiContext(f.paths.workspace, f.directory, f);
  const runId = crypto.randomUUID(); manager.appendCustomEntry("piko-run", { runId });
  const old = manager.appendMessage({ role: "user", content: "old input", timestamp: 1 });
  manager.appendMessage(assistant("old reply"));
  const kept = manager.appendMessage({ role: "user", content: "recent input", timestamp: 3 });
  manager.appendCompaction("summary", kept, 100);
  manager.appendContextEdit(old, null);
  const custom = manager.appendCustomMessageEntry("task-result", "daily report", true, { taskId: "task" });
  manager.appendCustomMessageEntry("hidden-guidance", "must stay hidden", false);
  const history = projectPiHistory(manager.getBranch());
  expect(history.messages.map((message) => message.content)).toEqual(["old input", "old reply", "recent input", "daily report"]);
  expect(history.messages[0]!.id).toBe("pi-" + old);
  expect(history.messages.at(-1)).toMatchObject({ id: "pi-" + custom, role: "assistant" });
  expect(history.messages.at(-1)!.runId).toBeUndefined();
  expect(history.runs.get(runId)).toEqual({ message: "old input", text: "old reply" });
  expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain("old input");
  const reference = exportPiReference(manager);
  const resumed = openPiContext(f.paths.workspace, f.directory, { ...f, state: reference });
  expect(projectPiHistory(resumed.getBranch())).toEqual(history);
  expect(reference).not.toHaveProperty("leafId");
});

test("UI follows the selected branch instead of combining every JSONL entry", () => {
  const f = fixture(); const manager = openPiContext(f.paths.workspace, f.directory, f);
  const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
  manager.appendMessage(assistant("abandoned branch"));
  manager.branch(root);
  manager.appendMessage(assistant("chosen branch"));
  expect(projectPiHistory(manager.getBranch()).messages.map((message) => message.content)).toEqual(["root", "chosen branch"]);
  const resumed = readPiContext(f.paths.workspace, f.directory, { ...f, state: exportPiReference(manager) })!;
  expect(projectPiHistory(resumed.getBranch())).toEqual(projectPiHistory(manager.getBranch()));
});

test("restart retains native tail and adds one context-only interruption notice without repeating input or tools", () => {
  const f = fixture(); const manager = openPiContext(f.paths.workspace, f.directory, f);
  const state = exportPiReference(manager), runId = crypto.randomUUID();
  manager.appendCustomEntry("piko-run", { runId });
  manager.appendMessage({ role: "user", content: "interrupted input", timestamp: 1 });
  manager.appendMessage(assistant("saved fragment"));
  const context = { ...f, state, interruptedRunIds: [runId] };
  const resumed = openPiContext(f.paths.workspace, f.directory, context);
  expect(projectPiHistory(resumed.getBranch()).messages.map((message) => message.content)).toEqual(["interrupted input", "saved fragment"]);
  expect(JSON.stringify(resumed.buildSessionContext().messages)).toContain("Do not resume or repeat");
  const again = openPiContext(f.paths.workspace, f.directory, context);
  expect(again.getEntries()).toHaveLength(resumed.getEntries().length);
});

test("native records ahead of SQL references remain canonical; missing or inconsistent referenced files fail closed", () => {
  const f = fixture();
  expect(readPiContext(f.paths.workspace, f.directory, f)).toBeUndefined();
  const first = openPiContext(f.paths.workspace, f.directory, f);
  const state = exportPiReference(first);
  first.appendMessage({ role: "user", content: "saved before SQL reference", timestamp: 1 });
  const adopted = openPiContext(f.paths.workspace, f.directory, f);
  expect(projectPiHistory(adopted.getBranch()).messages[0]!.content).toBe("saved before SQL reference");
  expect(() => readPiContext(f.paths.workspace, f.directory, { ...f, state: { ...state, sessionId: crypto.randomUUID() } })).toThrow("header");
  appendFileSync(join(f.directory, state.file), '{bad}\n');
  expect(() => openPiContext(f.paths.workspace, f.directory, { ...f, state })).toThrow("Corrupt JSONL");
  rmSync(join(f.directory, state.file));
  expect(() => openPiContext(f.paths.workspace, f.directory, { ...f, state })).toThrow("missing");
});

test("explicit workspace guidance and user-first skills refresh without ancestor resources or extensions", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "AGENTS.md"), "ANCESTOR_MUST_NOT_LOAD");
  writeFileSync(join(f.paths.workspace, "AGENTS.md"), "workspace instructions");
  const skill = join(f.paths.workspace, ".agents/skills/piko-workspace"); mkdirSync(skill);
  writeFileSync(join(skill, "SKILL.md"), "---\nname: piko-workspace\ndescription: User replacement\n---\nUser body\n");
  const global = join(f.paths.state, "pi/skills/foreign"); mkdirSync(global, { recursive: true });
  writeFileSync(join(global, "SKILL.md"), "---\nname: foreign\ndescription: Must not load\n---\nForeign body\n");
  writeFileSync(join(f.paths.workspace, ".pi-unrelated"), "not guidance");
  const { loader, settingsManager } = createWorkspaceResources(f.paths); await loader.reload();
  expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["piko-workspace"]);
  expect(loader.getSkills().skills[0].description).toBe("User replacement");
  expect(loader.getSkills().diagnostics.length).toBeGreaterThan(0);
  expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [{ path: join(f.paths.workspace, "AGENTS.md"), content: "workspace instructions" }] });
  expect(loader.getExtensions().extensions).toHaveLength(0);
  expect(settingsManager.getCompactionEnabled()).toBe(true);
  writeFileSync(join(f.paths.workspace, "USER.md"), "updated preference"); await loader.reload();
  expect(loader.getSystemPrompt()).toContain("updated preference");
  expect(loader.getSystemPrompt()).not.toContain("ANCESTOR_MUST_NOT_LOAD");
});
