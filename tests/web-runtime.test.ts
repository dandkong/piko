import { expect, spyOn, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools, getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { fixture, cleanup, waitUntil } from "./fixtures/durable";
import type { WebFetch } from "../server/tools/http";

function mockFetch(implementation: WebFetch) {
  const compatible = Object.assign((input: RequestInfo | URL, init?: RequestInit) =>
    implementation(input instanceof Request ? input.url : input, init), { preconnect: globalThis.fetch.preconnect });
  return spyOn(globalThis, "fetch").mockImplementation(compatible);
}

function searchEnvironment(value?: string) {
  const previous = process.env.BRAVE_SEARCH_API_KEY;
  if (value === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = value;
  cleanup(() => { if (previous === undefined) delete process.env.BRAVE_SEARCH_API_KEY; else process.env.BRAVE_SEARCH_API_KEY = previous; });
}

test("built-in web tools execute through Durable, use backend env, persist results and never serialize credentials", async () => {
  searchEnvironment();
  const f = await fixture(); const credential = "fake-local-search-key";
  await writeFile(join(f.paths.home, "config/.env"), `BRAVE_SEARCH_API_KEY='${credential}'\n`);
  let searches = 0; let extracts = 0;
  const transport = mockFetch(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.search.brave.com") {
      searches++;
      expect(new Headers(init?.headers).get("X-Subscription-Token") === credential).toBe(true);
      return new Response(JSON.stringify({ web: { results: [{ title: "Source", url: "https://example.com/article", description: "Read the original." }] } }));
    }
    if (url.href === "https://example.com/article") {
      extracts++; return new Response('<html><head><title>Original source</title></head><body><article><p>' + 'An original article with verifiable facts. '.repeat(30) + '</p></article></body></html>', { headers: { "Content-Type": "text/html" } });
    }
    throw new Error("Unexpected test URL");
  });
  cleanup(() => transport.mockRestore());
  const session = await f.createSession();
  // Env is captured at startup; a later process-env edit does not change this Harness.
  process.env.BRAVE_SEARCH_API_KEY = "different-key-after-startup";
  f.faux.setResponses([
    input => {
      const tools = getCurrentTools(input.messages);
      expect(tools.some(tool => tool.name === "web_search")).toBe(true);
      expect(tools.some(tool => tool.name === "web_extract")).toBe(true);
      expect(JSON.stringify(tools)).not.toContain(credential);
      expect(getCurrentSystemPrompt(input.messages)).toContain("Search sparingly");
      return fauxAssistantMessage(fauxToolCall("web_search", { query: "Find the original", maxResults: 1 }), { stopReason: "toolUse" });
    },
    input => {
      const result = input.messages.findLast(message => message.role === "toolResult");
      expect(result?.isError).toBe(false); expect(JSON.stringify(result)).toContain("https://example.com/article");
      expect(JSON.stringify(result)).not.toContain(credential);
      expect(JSON.stringify(result).toLowerCase()).not.toContain("brave");
      return fauxAssistantMessage(fauxToolCall("web_extract", { url: "https://example.com/article" }), { stopReason: "toolUse" });
    },
    input => {
      const result = input.messages.findLast(message => message.role === "toolResult");
      expect(result?.isError).toBe(false); expect(JSON.stringify(result)).toContain("# Original source");
      return fauxAssistantMessage("Verified from the original source.");
    },
  ]);
  await session.prompt("Research", { id: "web-integration", createdAt: 1 });
  expect(searches).toBe(1); expect(extracts).toBe(1);
  const description = await session.describe();
  expect(description.tools).toContainEqual({ name: "web_search", source: "builtin", status: "available" });
  expect(description.tools).toContainEqual({ name: "web_extract", source: "builtin", status: "available" });
  expect(description.plugins).toEqual([]);
  expect(JSON.stringify(description)).not.toContain(credential);
  const directory = join(f.paths.home, "state/durable");
  const log = await readFile(join(directory, "main.jsonl"), "utf8");
  expect(log).toContain('web_search'); expect(log).toContain('web_extract');
  expect(log).not.toContain(credential);
  await session.dispose();
  const restarted = await f.createSession();
  expect(restarted.messages.at(-1)?.content).toBe("Verified from the original source.");
  expect(searches).toBe(1); expect(extracts).toBe(1);
});

test("missing search credentials do not prevent startup or extraction and are visible only as safe status", async () => {
  searchEnvironment("");
  const f = await fixture(); const session = await f.createSession();
  expect((await session.describe()).tools).toContainEqual({ name: "web_search", source: "builtin", status: "unconfigured" });
  expect((await session.describe()).tools).toContainEqual({ name: "web_extract", source: "builtin", status: "available" });
  let networkCalls = 0;
  const transport = mockFetch(async () => { networkCalls++; throw new Error("No network expected"); });
  cleanup(() => transport.mockRestore());
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("web_search", { query: "needed information" }), { stopReason: "toolUse" }),
    input => {
      const result = input.messages.findLast(message => message.role === "toolResult");
      expect(result?.isError).toBe(true); expect(JSON.stringify(result)).toContain("not configured");
      expect(JSON.stringify(result).toLowerCase()).not.toContain("brave");
      return fauxAssistantMessage("Search is not configured on this backend.");
    },
  ]);
  await session.prompt("Search", { id: "missing-search", createdAt: 1 });
  expect(networkCalls).toBe(0);
  expect(session.messages.at(-1)?.content).toBe("Search is not configured on this backend.");
});

test("stopping a network call aborts its HTTP request without failing the next user input", async () => {
  searchEnvironment("fake-stop-key");
  const f = await fixture(); const entered = Promise.withResolvers<void>();
  let aborted = false;
  const transport = mockFetch(async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal as AbortSignal;
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true }); entered.resolve();
  }));
  cleanup(() => transport.mockRestore());
  const session = await f.createSession();
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("web_search", { query: "slow search" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Next input works."),
  ]);
  await session.submit("Search", "slow-network"); await entered.promise;
  expect(await session.abort()).toBe(true);
  await waitUntil(async () => (await session.submission("slow-network"))?.status === "unanswered");
  expect(aborted).toBe(true); expect(session.isStreaming).toBe(false);
  await session.prompt("Next", { id: "after-network-stop", createdAt: 2 });
  expect(session.messages.at(-1)?.content).toBe("Next input works.");
});

test("workspace extensions remain distinguishable and cannot register a built-in web tool name", async () => {
  const f = await fixture();
  await writeFile(join(f.paths.home, "extensions/custom.ts"), `import { Type } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
export default defineExtension({name:"custom-extension",tools:[defineTool({name:"custom_tool",description:"Custom tool",parameters:Type.Object({}),execute:async()=>({content:[{type:"text",text:"custom"}]})})]});`);
  const session = await f.createSession();
  expect((await session.describe()).tools).toContainEqual({ name: "custom_tool", source: "extension", status: "available" });
  await session.dispose();
  await writeFile(join(f.paths.home, "extensions/replace.ts"), `import { Type } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
export default defineExtension({name:"replacement",tools:[defineTool({name:"web_search",description:"Replacement",parameters:Type.Object({}),execute:async()=>({})})]});`);
  await expect(f.createSession()).rejects.toThrow("reserved built-in tool web_search");
});
