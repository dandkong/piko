import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createPiSession } from "../server/runtime/pi";
import { initializeWorkspace, resolveWorkspacePaths } from "../server/domain/workspace";

const roots: string[] = [];
const sessions: Awaited<ReturnType<typeof createPiSession>>["session"][] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "piko-tools-test-")); roots.push(root);
  const paths = initializeWorkspace(resolveWorkspacePaths({ PIKO_HOME: root }));
  // Only static catalogs and a test-only credential: no personal profile or paid model calls.
  const runtime = await ModelRuntime.create({ authPath: join(paths.state, "test-auth.json"), modelsPath: null, refreshOnCreate: false });
  const model = runtime.getModels("openai")[0]!;
  await runtime.setRuntimeApiKey(model.provider, "test-only-not-a-real-key");
  const profile = SettingsManager.inMemory({ defaultProvider: model.provider, defaultModel: model.id });
  const { session } = await createPiSession(paths, { threadId: crypto.randomUUID(), recovery: [] }, runtime, profile);
  sessions.push(session);
  async function execute(name: string, args: Record<string, unknown>) {
    const tool = session.agent.state.tools.find((tool) => tool.name === name);
    if (!tool) throw new Error(`Tool ${name} is not registered`);
    return tool.execute(crypto.randomUUID(), args);
  }
  return { paths, session, execute };
}

function resultText(result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["execute"]>>) {
  return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

test("only read, write, edit and bash are exposed after resource reload and operate from the workspace", async () => {
  const f = await fixture();
  const expected = ["bash", "edit", "read", "write"];
  expect(f.session.getActiveToolNames().sort()).toEqual(expected);
  expect(f.session.getAllTools().map((tool) => tool.name).sort()).toEqual(expected);
  await f.session.reload();
  expect(f.session.getActiveToolNames().sort()).toEqual(expected);
  expect(f.session.getAllTools().map((tool) => tool.name).sort()).toEqual(expected);
  expect(f.session.systemPrompt).not.toContain("You currently have no tools");
  expect(f.session.systemPrompt).toContain("<available_skills>");
  await f.execute("write", { path: "artifacts/probe.txt", content: "hello from Piko" });
  await f.execute("edit", { path: "artifacts/probe.txt", edits: [{ oldText: "hello", newText: "updated" }] });
  expect(resultText(await f.execute("read", { path: "artifacts/probe.txt" }))).toContain("updated from Piko");
  expect(readFileSync(join(f.paths.workspace, "artifacts/probe.txt"), "utf8")).toBe("updated from Piko");
  const skillPath = ".agents/skills/new-skill/SKILL.md";
  await f.execute("write", { path: skillPath, content: "---\nname: new-skill\ndescription: A test user skill\n---\nRead this body before use.\n" });
  expect(resultText(await f.execute("read", { path: skillPath }))).toContain("Read this body");
  await f.session.reload();
  expect(f.session.systemPrompt).toContain("new-skill");
  expect(f.session.getActiveToolNames().sort()).toEqual(expected);
});

test("Bash runs a script from the workspace", async () => {
  const f = await fixture();
  await f.execute("write", { path: "artifacts/probe.sh", content: "printf 'piko-bash-working'\n" });
  expect(resultText(await f.execute("bash", { command: "bash artifacts/probe.sh", timeout: 10 }))).toContain("piko-bash-working");
});
