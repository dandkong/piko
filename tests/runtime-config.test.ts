import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { fixture, cleanup, repository, waitUntil } from "./fixtures/durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { createPiRuntime } from "../server/runtime/pi";
import { createApp } from "../server/app";
import { ConversationStore } from "../server/chat/conversations";
import { defaultServerConfig } from "../server/config";
import { FileCredentialStore } from "../server/runtime/credentials";

const plugin = (value: string) => `
import { Type } from "typebox";
import { Type as PiType } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { label } from "./lib/helper.ts";
const State = defineDoc({ kind: "test.remember", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({ value: "" }) });
export default defineExtension({ name: "remember", tools: [defineTool({ name: "remember", description: "Remember a test value", parameters: Type.Object({}),
execute: async (_args, api, context) => { if (Type !== PiType) throw new Error("TypeBox identity mismatch");
await api.commit(async tx => { const state = await tx.doc(State, api.conversationId); state.value = ${JSON.stringify(value)} + label; }, context);
return { content: [{ type: "text", text: ${JSON.stringify(value)} + label }] }; } })] });
`;

test("native workspace plugins execute tools and preserve docs; code changes take effect after restart", async () => {
  const f = await fixture();
  const directory = join(f.paths.home, "extensions/remember"); await mkdir(join(directory, "lib"), { recursive: true });
  await writeFile(join(directory, "index.ts"), plugin("one-"));
  await writeFile(join(directory, "lib/helper.ts"), 'export const label = "a";');
  let session = await f.createSession();
  expect((await f.runtime.describe!(f.input)).plugins[0]).toMatchObject({ name: "remember", tools: ["remember"] });
  const run = async (expected: string) => {
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("remember", {}), { stopReason: "toolUse" }),
      context => { expect(JSON.stringify(context.messages)).toContain(expected); return fauxAssistantMessage(expected); }]);
    await session.prompt("remember", { id: crypto.randomUUID(), createdAt: Date.now() });
  };
  await run("one-a");
  await writeFile(join(directory, "lib/helper.ts"), 'export const label = "b";');
  await run("one-a");
  await f.runtime.dispose!();
  const restarted = f.createRuntime();
  session = await restarted.createSession(f.input);
  await run("one-b");
  await writeFile(join(directory, "index.ts"), "syntax is broken ???");
  await run("one-b");
  const state = session.exportState!(); await session.dispose();
  await expect(restarted.createSession(f.input)).rejects.toThrow("Cannot load plugin");
  await writeFile(join(directory, "index.ts"), plugin("one-"));
  session = await restarted.createSession(f.input);
  expect(session.messages.at(-1)?.content).toBe("one-b");
  expect((await restarted.readHistory({ ...f.input, state })).messages.at(-1)?.content).toBe("one-b");
  const data = await readFile(join(f.paths.home, "state/durable-sessions", f.input.threadId, "main.jsonl"), "utf8");
  expect(data).toContain("test.remember");
});

test("model profiles and thinking selections persist across restart; file edits leave the active runtime unchanged", async () => {
  const f = await fixture(); const settings = join(f.paths.home, "config/settings.json");
  await writeFile(settings, JSON.stringify({ version: 1, defaultProfile: "quick", profiles: {
    quick: { provider: "faux", model: "fast", thinking: "off" }, review: { provider: "faux", model: "reasoning", thinking: "high" },
  } }));
  const repo = repository(f.paths); const config = defaultServerConfig();
  const store = new ConversationStore(f.runtime.createSession, config, repo, f.runtime.readHistory);
  const app = createApp({ config, runtime: f.runtime, conversations: store });
  const input = repo.context(repo.main.sessionId);
  const post = (path: string, value?: unknown) => app(new Request("http://local/api/runtime/" + path,
    { method: "POST", ...(value !== undefined ? { body: JSON.stringify(value) } : {}) }));
  expect((await (await app(new Request("http://local/api/runtime"))).json()).selection.model).toBe("fast");
  expect((await post("selection", { profile: "review" })).status).toBe(200);
  expect((await f.runtime.describe!(input)).selection).toEqual({ provider: "faux", model: "reasoning", thinking: "high" });
  expect((await post("selection", { thinking: "bogus" })).status).toBe(422);
  expect((await post("selection", { provider: "faux", model: "fast", thinking: "high" })).status).toBe(409);
  await writeFile(settings, '{"credential":"must-not-leak"');
  const response = await post("reload"); expect(response.status).toBe(404); expect(await response.text()).not.toContain("must-not-leak");
  f.faux.setResponses([fauxAssistantMessage("still works")]);
  const session = await f.runtime.createSession(input);
  await session.prompt("hello", { id: crypto.randomUUID(), createdAt: 1 });
  const state = session.exportState!(); await session.dispose();
  await writeFile(settings, JSON.stringify({ version: 1 }));
  await f.runtime.createSession({ ...input, state });
  expect((await f.runtime.describe!({ ...input, state })).selection?.thinking).toBe("high");
  await f.runtime.dispose!(); await store.dispose();
});

test("JSON model and auth configuration reaches a real local OpenAI-compatible request without personal credentials", async () => {
  const f = await fixture(); const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>; requests.push({ headers: request.headers, body });
    const chunk = (delta: unknown, finish_reason: string | null = null) => JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta, finish_reason }] });
    return new Response(`data: ${chunk({ role: "assistant", content: "local answer" })}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } });
  } }); cleanup(() => server.stop(true));
  const config = join(f.paths.home, "config");
  await writeFile(join(config, ".env"), "PIKO_CONFIG_TEST_HEADER=shared-local-env-value\n");
  await writeFile(join(config, "models.json"), JSON.stringify({ providers: { local: {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${server.port}/v1`, request: { temperature: 0.2, maxTokens: 128 },
    headers: { "x-piko-config-test": "env:PIKO_CONFIG_TEST_HEADER" },
    compat: { supportsReasoningEffort: true, supportsStore: false, maxTokensField: "max_tokens" },
    models: [{ id: "test-model", contextWindow: 32000, maxTokens: 4096, reasoning: true, samplingParams: { top_p: 0.7 } }],
  } } }));
  await writeFile(join(config, "auth.json"), JSON.stringify({ local: { type: "api_key", key: "only-local-test-key" } }));
  await writeFile(join(config, "settings.json"), JSON.stringify({ version: 1, defaultProfile: "main", profiles: {
    main: { provider: "local", model: "test-model", thinking: "high" },
  } }));
  const runtime = createPiRuntime(f.paths); cleanup(() => runtime.dispose!());
  const session = await runtime.createSession(f.input);
  await session.prompt("local only", { id: crypto.randomUUID(), createdAt: 1 });
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer only-local-test-key");
  expect(requests[0]?.headers.get("x-piko-config-test")).toBe("shared-local-env-value");
  expect(requests[0]?.body).toMatchObject({ model: "test-model", temperature: 0.2, max_tokens: 128, top_p: 0.7, reasoning_effort: "high" });
  expect(JSON.stringify(await runtime.describe!(f.input))).not.toContain("only-local-test-key");
  expect(session.messages.at(-1)?.content).toBe("local answer");
});

test("credential writes serialize and invalid file edits do not replace the active store", async () => {
  const f = await fixture(); const path = join(f.paths.home, "config/auth.json");
  const store = new FileCredentialStore(path);
  await store.modify("test", async () => ({ type: "api_key", key: "0" }));
  await Promise.all(Array.from({ length: 10 }, () => store.modify("test", async current => {
    await Bun.sleep(1); return { type: "api_key", key: String(Number(current?.type === "api_key" ? current.key : "0") + 1) };
  })));
  expect(await store.read("test")).toEqual({ type: "api_key", key: "10" });
  await writeFile(path, "invalid");
  expect(() => new FileCredentialStore(path)).toThrow("Invalid JSON");
  expect(await store.read("test")).toEqual({ type: "api_key", key: "10" });
});

test("a model-free conversation can activate newly configured credentials and profile after restart", async () => {
  const f = await fixture(); const models = createModels();
  const runtime = createPiRuntime(f.paths, { models }); cleanup(() => runtime.dispose!());
  await runtime.createSession(f.input);
  expect((await runtime.describe!(f.input)).selection).toBeUndefined();
  models.setProvider(f.faux.provider);
  await writeFile(join(f.paths.home, "config/settings.json"), JSON.stringify({ version: 1, defaultProfile: "main",
    profiles: { main: { provider: "faux", model: "reasoning", thinking: "high" } } }));
  await runtime.dispose!();
  const restarted = createPiRuntime(f.paths, { models }); cleanup(() => restarted.dispose!());
  const session = await restarted.createSession(f.input);
  expect((await restarted.describe!(f.input)).selection).toEqual({ provider: "faux", model: "reasoning", thinking: "high" });
  f.faux.setResponses([fauxAssistantMessage("configured")]);
  await session.prompt("hello", { id: crypto.randomUUID(), createdAt: 1 });
  expect(session.messages.at(-1)?.content).toBe("configured");
});

test("runtime cancel preserves the Run cancellation state while generation is busy", async () => {
  const f = await fixture(5); const repo = repository(f.paths); const config = defaultServerConfig();
  const store = new ConversationStore(f.runtime.createSession, config, repo, f.runtime.readHistory);
  cleanup(() => store.close());
  const app = createApp({ config, runtime: f.runtime, conversations: store });
  f.faux.setResponses([fauxAssistantMessage("A long answer that should be stopped while streaming.")]);
  const run = await store.startRun(repo.main.sessionId, crypto.randomUUID(), "stop this");
  await waitUntil(() => f.faux.state.callCount > 0);
  const compact = await app(new Request("http://local/api/runtime/compact", { method: "POST" }));
  expect(compact.status).toBe(409);
  const removed = await app(new Request("http://local/api/runtime/reload", { method: "POST" }));
  expect(removed.status).toBe(404);
  const response = await app(new Request("http://local/api/runtime/cancel", { method: "POST" }));
  expect(response.status).toBe(200);
  await waitUntil(() => !run.active);
  expect(run.snapshot.status).toBe("cancelled");
  expect(repo.run(repo.main.sessionId, run.snapshot.id)?.status).toBe("cancelled");
});
