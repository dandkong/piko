import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createPiSession, adaptPiSession } from "../server/runtime/pi";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { assistant } from "./fixtures/pi-message";
import { openPiContext } from "../server/runtime/pi-context";
import { projectPiHistory } from "../server/runtime/pi-history";
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
  const context = { threadId: crypto.randomUUID(), interruptedRunIds: [] };
  const { session, sessionManager } = await createPiSession(paths, context, runtime, profile);
  sessions.push(session);
  async function execute(name: string, args: Record<string, unknown>) {
    const tool = session.agent.state.tools.find((tool) => tool.name === name);
    if (!tool) throw new Error(`Tool ${name} is not registered`);
    return tool.execute(crypto.randomUUID(), args);
  }
  return { paths, session, sessionManager, context, execute, modelRuntime: runtime };
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

test("real Pi prompt persists each input once, associates native output with its Run, and includes custom results in the next context", async () => {
  const f = await fixture();
  let modelCalls = 0;
  let modelContext = "";
  // Real Pi agent/session lifecycle, deterministic local model stream, no network or personal credentials.
  f.modelRuntime.streamSimple = (_model, context) => {
    modelCalls++; modelContext = JSON.stringify(context.messages);
    const stream = createAssistantMessageEventStream();
    const message = assistant("native reply"), partial = assistant("");
    stream.push({ type: "start", partial });
    stream.push({ type: "text_start", contentIndex: 0, partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "native reply", partial: message });
    stream.push({ type: "text_end", contentIndex: 0, content: "native reply", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  };
  const adapter = adaptPiSession(f.session, f.sessionManager);
  const runId = crypto.randomUUID(); const deltas: string[] = [];
  const unsubscribe = adapter.subscribe((event) => { if (event.type === "delta") deltas.push(event.text); });
  const input = "/skill:piko-workspace";
  await adapter.prompt(input, { id: runId, createdAt: 1 });
  expect(deltas.join("")).toBe("native reply");
  const history = projectPiHistory(f.sessionManager.getBranch());
  expect(history.messages.map((message) => message.content)).toEqual([input, "native reply"]);
  expect(history.runs.get(runId)).toEqual({ message: input, text: "native reply" });
  await f.session.sendCustomMessage({ customType: "task-result", content: "scheduled summary", display: true,
    details: { resultId: "result-1" } }, { triggerTurn: false });
  expect(modelCalls).toBe(1);
  await adapter.prompt("explain the summary", { id: crypto.randomUUID(), createdAt: 2 });
  expect(modelCalls).toBe(2);
  expect(modelContext).toContain("scheduled summary");
  const reopened = openPiContext(f.paths.workspace, join(f.paths.state, "pi-sessions"), { ...f.context, state: adapter.exportState!() });
  const saved = projectPiHistory(reopened.getBranch());
  expect(saved.messages.map((message) => message.content)).toEqual([
    input, "native reply", "scheduled summary", "explain the summary", "native reply",
  ]);
  expect(saved.messages).toEqual(adapter.messages);
  unsubscribe();
});
