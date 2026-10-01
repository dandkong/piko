import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPiCheckpoint, openPiContext } from "../server/runtime/pi-context";
import { createWorkspaceResources } from "../server/runtime/resources";
import { initializeWorkspace, resolveWorkspacePaths } from "../server/domain/workspace";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "piko-pi-test-")); roots.push(root);
  const paths = initializeWorkspace(resolveWorkspacePaths({ PIKO_HOME: root }));
  return { root, paths, directory: join(paths.state, "pi-sessions"), threadId: crypto.randomUUID() };
}

test("native Pi JSONL preserves compaction, resumes the committed branch, and records interrupted output without repeating it", () => {
  const f = fixture(); const manager = openPiContext(f.paths.workspace, f.directory, { threadId: f.threadId, recovery: [] });
  manager.appendMessage({ role: "user", content: "first input", timestamp: 1 });
  const first = manager.getLeafId()!;
  manager.appendCompaction("first summary", first, 100);
  const state = exportPiCheckpoint(manager);
  manager.appendMessage({ role: "user", content: "abandoned input", timestamp: 2 });
  const resumed = openPiContext(f.paths.workspace, f.directory, { threadId: f.threadId, state, recovery: [
    { runId: crypto.randomUUID(), message: "abandoned input", text: "partial", status: "interrupted" },
  ] });
  const context = resumed.buildSessionContext();
  expect(JSON.stringify(context.messages)).toContain("first summary");
  expect(JSON.stringify(context.messages)).toContain("historical data, not a request to repeat");
  expect(context.messages.filter((message) => message.role === "user")).toHaveLength(1);
  expect(resumed.getEntries()).toHaveLength(manager.getEntries().length + 1);
  const saved = exportPiCheckpoint(resumed);
  const reopened = openPiContext(f.paths.workspace, f.directory, { threadId: f.threadId, state: saved, recovery: [] });
  expect(reopened.buildSessionContext()).toEqual(context);
});

test("a header created before its SQL checkpoint is recoverable, while inconsistent files fail closed", () => {
  const f = fixture();
  const first = openPiContext(f.paths.workspace, f.directory, { threadId: f.threadId, recovery: [] });
  const headerOnly = openPiContext(f.paths.workspace, f.directory, { threadId: f.threadId, recovery: [] });
  expect(headerOnly.getSessionId()).toBe(first.getSessionId());
  first.appendMessage({ role: "user", content: "interrupted", timestamp: 1 });
  expect(() => openPiContext(f.paths.workspace, f.directory, { threadId: f.threadId, recovery: [] })).toThrow("without its checkpoint");
  const resumed = openPiContext(f.paths.workspace, f.directory, { threadId: f.threadId, recovery: [
    { runId: crypto.randomUUID(), message: "interrupted", text: "", status: "interrupted" },
  ] });
  expect(resumed.buildSessionContext().messages.filter((message) => message.role === "user")).toHaveLength(0);
  const state = exportPiCheckpoint(resumed);
  expect(() => openPiContext(f.paths.workspace, f.directory, { threadId: f.threadId, state: { ...state, leafId: "missing" }, recovery: [] })).toThrow("missing entry");
  appendFileSync(join(f.directory, state.file), '{bad}\n');
  expect(() => openPiContext(f.paths.workspace, f.directory, { threadId: f.threadId, state, recovery: [] })).toThrow("Corrupt JSONL");
  rmSync(join(f.directory, state.file));
  expect(() => openPiContext(f.paths.workspace, f.directory, { threadId: f.threadId, state, recovery: [] })).toThrow("missing");
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
