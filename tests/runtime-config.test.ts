import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { fixture, cleanup, waitUntil } from "./fixtures/durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { createPiRuntime } from "../server/runtime/pi";
import { createApp } from "../server/app";
import { ConversationStore } from "../server/chat/conversations";
import { defaultServerConfig } from "../server/config";
import { loadWorkspaceModels } from "../server/runtime/model-config";

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
  expect((await f.runtime.describe!()).plugins[0]).toMatchObject({ name: "remember", tools: ["remember"] });
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
  session = await restarted.createSession() as import("../server/runtime/pi").DurableChatSession;
  await run("one-b");
  await writeFile(join(directory, "index.ts"), "syntax is broken ???");
  await run("one-b");
  await session.dispose();
  await expect(restarted.createSession()).rejects.toThrow("Cannot load plugin");
  await writeFile(join(directory, "index.ts"), plugin("one-"));
  session = await restarted.createSession() as import("../server/runtime/pi").DurableChatSession;
  expect(session.messages.at(-1)?.content).toBe("one-b");
  expect((await restarted.readHistory()).messages.at(-1)?.content).toBe("one-b");
  const data = await readFile(join(f.paths.home, "state/durable", "main.jsonl"), "utf8");
  expect(data).toContain("test.remember");
});

test("model profiles and thinking selections persist across restart; file edits leave the active runtime unchanged", async () => {
  const f = await fixture(); const settings = join(f.paths.home, "config/settings.json");
  await writeFile(settings, JSON.stringify({ version: 1, defaultProfile: "quick", profiles: {
    quick: { provider: "faux", model: "fast", thinking: "off" }, review: { provider: "faux", model: "reasoning", thinking: "high" },
  } }));
  const config = defaultServerConfig();
  const store = new ConversationStore(f.runtime);
  const app = createApp({ config, runtime: f.runtime, conversations: store });
  const post = (path: string, value?: unknown) => app(new Request("http://local/api/runtime/" + path,
    { method: "POST", ...(value !== undefined ? { body: JSON.stringify(value) } : {}) }));
  expect((await (await app(new Request("http://local/api/runtime"))).json()).selection.model).toBe("fast");
  expect((await post("selection", { profile: "review" })).status).toBe(200);
  expect((await f.runtime.describe!()).selection).toEqual({ provider: "faux", model: "reasoning", thinking: "high" });
  expect((await post("selection", { thinking: "bogus" })).status).toBe(422);
  expect((await post("selection", { provider: "faux", model: "fast", thinking: "high" })).status).toBe(409);
  await writeFile(settings, '{"credential":"must-not-leak"');
  const response = await post("reload"); expect(response.status).toBe(404); expect(await response.text()).not.toContain("must-not-leak");
  f.faux.setResponses([fauxAssistantMessage("still works")]);
  const session = await f.createSession();
  await session.prompt("hello", { id: crypto.randomUUID(), createdAt: 1 });
  await store.close();
  await writeFile(settings, JSON.stringify({ version: 1 }));
  await f.runtime.createSession();
  expect((await f.runtime.describe!()).selection?.thinking).toBe("high");
  await f.runtime.dispose!();
});

test("JSON model behavior and environment-only credentials reach a real local OpenAI-compatible request", async () => {
  const f = await fixture(); const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>; requests.push({ headers: request.headers, body });
    const chunk = (delta: unknown, finish_reason: string | null = null) => JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta, finish_reason }] });
    return new Response(`data: ${chunk({ role: "assistant", content: "local answer" })}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } });
  } }); cleanup(() => server.stop(true));
  const config = join(f.paths.home, "config");
  await writeFile(join(config, ".env"), "PIKO_CONFIG_TEST_HEADER=shared-local-env-value\nCUSTOM_API_KEY=only-local-test-key\n");
  await writeFile(join(config, "models.json"), JSON.stringify({ providers: { custom: {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${server.port}/v1`, request: { temperature: 0.2, maxTokens: 128 },
    headersEnv: { "x-piko-config-test": "PIKO_CONFIG_TEST_HEADER" },
    compat: { supportsReasoningEffort: true, supportsStore: false, maxTokensField: "max_tokens" },
    models: [{ id: "test-model", contextWindow: 32000, maxTokens: 4096, reasoning: true, samplingParams: { top_p: 0.7 } }],
  } } }));
  await writeFile(join(config, "settings.json"), JSON.stringify({ version: 1, defaultProfile: "main", profiles: {
    main: { provider: "custom", model: "test-model", thinking: "high" },
  } }));
  const runtime = createPiRuntime(f.paths); cleanup(() => runtime.dispose!());
  const session = await runtime.createSession() as import("../server/runtime/pi").DurableChatSession;
  await session.prompt("local only", { id: crypto.randomUUID(), createdAt: 1 });
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer only-local-test-key");
  expect(requests[0]?.headers.get("x-piko-config-test")).toBe("shared-local-env-value");
  expect(requests[0]?.body).toMatchObject({ model: "test-model", temperature: 0.2, max_tokens: 128, top_p: 0.7, reasoning_effort: "high" });
  expect(JSON.stringify(await runtime.describe!())).not.toContain("only-local-test-key");
  expect(session.messages.at(-1)?.content).toBe("local answer");
  await writeFile(join(config, ".env"), "PIKO_CONFIG_TEST_HEADER=edited-header\nCUSTOM_API_KEY=edited-test-key\n");
  await session.prompt("Still startup credentials", { id: crypto.randomUUID(), createdAt: 2 });
  expect(requests[1]?.headers.get("authorization")).toBe("Bearer only-local-test-key");
  expect(requests[1]?.headers.get("x-piko-config-test")).toBe("shared-local-env-value");
  await runtime.dispose!();
  const restarted = createPiRuntime(f.paths); cleanup(() => restarted.dispose!());
  const next = await restarted.createSession() as import("../server/runtime/pi").DurableChatSession;
  await next.prompt("Updated after restart", { id: crypto.randomUUID(), createdAt: 3 });
  expect(requests[2]?.headers.get("authorization")).toBe("Bearer edited-test-key");
  expect(requests[2]?.headers.get("x-piko-config-test")).toBe("edited-header");
  const log = await readFile(join(f.paths.home, "state/durable/main.jsonl"), "utf8");
  expect(log).not.toContain("only-local-test-key"); expect(log).not.toContain("edited-test-key");
});

test("legacy credential JSON is rejected rather than falling back or overriding environment credentials", async () => {
  const f = await fixture();
  await writeFile(join(f.paths.home, "config/auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "private-old-key" } }));
  await writeFile(join(f.paths.home, "config/.env"), "DEEPSEEK_API_KEY=private-new-key\n");
  await expect(loadWorkspaceModels(f.paths.home)).rejects.toThrow("auth.json is no longer a credential source");
  await expect(loadWorkspaceModels(f.paths.home)).rejects.not.toThrow("private-old-key");
});

test("a model-free conversation can activate newly configured credentials and profile after restart", async () => {
  const f = await fixture(); const models = createModels();
  const runtime = createPiRuntime(f.paths, { models }); cleanup(() => runtime.dispose!());
  await runtime.createSession();
  expect((await runtime.describe!()).selection).toBeUndefined();
  models.setProvider(f.faux.provider);
  await writeFile(join(f.paths.home, "config/settings.json"), JSON.stringify({ version: 1, defaultProfile: "main",
    profiles: { main: { provider: "faux", model: "reasoning", thinking: "high" } } }));
  await runtime.dispose!();
  const restarted = createPiRuntime(f.paths, { models }); cleanup(() => restarted.dispose!());
  const session = await restarted.createSession() as import("../server/runtime/pi").DurableChatSession;
  expect((await restarted.describe!()).selection).toEqual({ provider: "faux", model: "reasoning", thinking: "high" });
  f.faux.setResponses([fauxAssistantMessage("configured")]);
  await session.prompt("hello", { id: crypto.randomUUID(), createdAt: 1 });
  expect(session.messages.at(-1)?.content).toBe("configured");
});

test("runtime cancel settles native input state while generation is busy", async () => {
  const f = await fixture(5); const config = defaultServerConfig();
  const store = new ConversationStore(f.runtime);
  cleanup(() => store.close());
  const app = createApp({ config, runtime: f.runtime, conversations: store });
  f.faux.setResponses([fauxAssistantMessage("A long answer that should be stopped while streaming.")]);
  const id = crypto.randomUUID(); await store.submit("stop this", id);
  await waitUntil(() => f.faux.state.callCount > 0);
  const compact = await app(new Request("http://local/api/runtime/compact", { method: "POST" }));
  expect(compact.status).toBe(409);
  const removed = await app(new Request("http://local/api/runtime/reload", { method: "POST" }));
  expect(removed.status).toBe(404);
  const response = await app(new Request("http://local/api/runtime/cancel", { method: "POST" }));
  expect(response.status).toBe(200);
  await waitUntil(() => !store.isStreaming());
  expect((await (await store.get()).submission(id))?.status).toBe("unanswered");
});
