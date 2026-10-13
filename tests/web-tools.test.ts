import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { Compile } from "typebox/compile";
import { createWebTools } from "../server/runtime/web-tools";
import { searchWeb } from "../server/tools/web-search";
import { extractWebPage, extractedPageMarkdown } from "../server/tools/web-extract";
import { readResponseText, type WebFetch } from "../server/tools/http";

const KEY = "fake-search-credential-for-tests";
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const htmlResponse = (html: string) => new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
const article = `<!DOCTYPE html><html><head><title>Readable article</title><meta name="author" content="Example Author"><meta property="og:site_name" content="Example Site"></head><body><nav>Navigation only</nav><article><h1>Readable article</h1><p>${"An important passage of original source text. ".repeat(60)}</p><h2>More details</h2><p>Read the <a href="/reference">reference</a>.</p><ul><li>First point</li><li>Second point</li></ul><pre><code>const value = 1;</code></pre></article><footer>Footer only</footer></body></html>`;

function pendingFetch(signalSeen: (signal: AbortSignal) => void): WebFetch {
  return async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal as AbortSignal; signalSeen(signal);
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

test("public tools retain the existing schemas and do not expose credentials or a search provider", () => {
  const web = createWebTools({ BRAVE_SEARCH_API_KEY: KEY });
  const tools = web.extension.tools!;
  expect(tools.map(tool => tool.name)).toEqual(["web_search", "web_extract"]);
  const search = tools[0].parameters as { properties: Record<string, unknown> };
  const extract = tools[1].parameters as { properties: Record<string, unknown> };
  expect(Object.keys(search.properties)).toEqual(["query", "maxResults"]);
  expect(Object.keys(extract.properties)).toEqual(["url", "maxChars"]);
  const schema = Compile(tools[0].parameters);
  expect(schema.Check({ query: "search" })).toBe(true);
  for (const maxResults of [0, 11, 1.5]) expect(schema.Check({ query: "search", maxResults })).toBe(false);
  const pageSchema = Compile(tools[1].parameters);
  expect(pageSchema.Check({ url: "https://example.com", maxChars: 100000 })).toBe(true);
  expect(pageSchema.Check({ url: "https://example.com", maxChars: 999 })).toBe(false);
  expect(JSON.stringify(tools)).not.toContain(KEY);
  expect(JSON.stringify(tools).toLowerCase()).not.toContain("brave");
  expect(web.searchConfigured).toBe(true);
  expect(createWebTools({}).searchConfigured).toBe(false);
});

test("search uses trimmed query, default count and private authorization; only formatted results escape", async () => {
  let calls = 0;
  const fetch: WebFetch = async (input, init) => {
    calls++;
    const url = new URL(String(input));
    expect(url.searchParams.get("q")).toBe("test query");
    expect(url.searchParams.get("count")).toBe("5");
    expect(new Headers(init!.headers).get("X-Subscription-Token") === KEY).toBe(true);
    expect(init?.redirect).toBe("error");
    return jsonResponse({ private: KEY, query: { altered: "corrected query" }, web: { results: [
      { title: "A source", url: "https://example.com/source", description: "Useful summary.", extra_snippets: ["More information."] },
    ] } });
  };
  const result = await searchWeb({ query: "  test query  " }, { apiKey: KEY, fetch });
  expect(calls).toBe(1);
  expect(result).toBe("Altered query: corrected query\n\nResults:\n1. A source\n   https://example.com/source\n   Useful summary.\n   More information.");
  expect(result).not.toContain(KEY);
  expect(result.toLowerCase()).not.toContain("brave");
});

test("search respects result and snippet limits and handles an empty result without leaking provider JSON", async () => {
  const result = await searchWeb({ query: "test", maxResults: 2 }, { apiKey: KEY, fetch: async input => {
    expect(new URL(String(input)).searchParams.get("count")).toBe("2");
    return jsonResponse({ web: { results: Array.from({ length: 10 }, (_, i) => ({ title: `Title ${i}`, description: "x".repeat(2000) })) } });
  } });
  expect(result).toContain("Title 1"); expect(result).not.toContain("Title 2"); expect(result).toContain("truncated 800 chars");
  expect(await searchWeb({ query: "empty" }, { apiKey: KEY, fetch: async () => jsonResponse({ query: { original: "empty" }, secret: KEY }) })).toBe("No results found.");
  const redacted = await searchWeb({ query: "echo" }, { apiKey: KEY, fetch: async () => jsonResponse({ web: { results: [{ title: KEY }] } }) });
  expect(redacted).not.toContain(KEY); expect(redacted).toContain("[redacted]");
});

test("unconfigured and invalid searches fail before network access", async () => {
  let calls = 0; const fetch: WebFetch = async () => { calls++; return jsonResponse({}); };
  await expect(searchWeb({ query: "test" }, { fetch })).rejects.toThrow("not configured");
  for (const query of ["", "  ", "null", "undefined", "none"]) await expect(searchWeb({ query }, { apiKey: KEY, fetch })).rejects.toThrow("query is required");
  expect(calls).toBe(0);
});

test("search HTTP/network/JSON failures never return upstream bodies, credentials or provider names", async () => {
  for (const status of [401, 403, 429, 500]) {
    let error: unknown;
    try { await searchWeb({ query: "test" }, { apiKey: KEY, fetch: async () => new Response(`brave upstream error ${KEY}`, { status }) }); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(KEY); expect(String(error).toLowerCase()).not.toContain("brave");
    expect(String(error)).toContain(status === 429 ? "rate limited" : status === 500 ? "HTTP 500" : "authentication failed");
  }
  for (const fetch of [
    async () => { throw new Error(`network error brave ${KEY}`); },
    async () => new Response(`not JSON brave ${KEY}`),
    async () => jsonResponse({ error: `brave ${KEY}` }),
  ] as WebFetch[]) {
    let failure: unknown;
    try { await searchWeb({ query: "test" }, { apiKey: KEY, fetch }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(KEY); expect(String(failure).toLowerCase()).not.toContain("brave");
  }
});

test("network tools honor pre-cancelled calls, in-flight cancellation and bounded timeouts", async () => {
  const already = new AbortController(); already.abort(new Error("cancelled"));
  let calls = 0; const fetch: WebFetch = async () => { calls++; return jsonResponse({}); };
  await expect(searchWeb({ query: "test" }, { apiKey: KEY, fetch }, already.signal)).rejects.toThrow("cancelled");
  await expect(extractWebPage({ url: "https://example.com" }, { fetch }, already.signal)).rejects.toThrow("cancelled");
  expect(calls).toBe(0);
  const cancel = new AbortController(); const entered = Promise.withResolvers<void>();
  const pending = searchWeb({ query: "test" }, { apiKey: KEY, fetch: pendingFetch(() => entered.resolve()) }, cancel.signal);
  await entered.promise; cancel.abort(new Error("stopped by user")); await expect(pending).rejects.toThrow("stopped by user");
  await expect(searchWeb({ query: "test" }, { apiKey: KEY, timeoutMs: 10, fetch: pendingFetch(() => {}) })).rejects.toThrow("timed out");
  await expect(extractWebPage({ url: "https://example.com" }, { timeoutMs: 10, fetch: pendingFetch(() => {}) })).rejects.toThrow("timed out");
});

test("response reads enforce both advertised and streamed size limits and cancel a blocked body", async () => {
  await expect(readResponseText(new Response("abc", { headers: { "Content-Length": "100" } }), 10)).rejects.toThrow("byte limit");
  await expect(readResponseText(new Response("long body"), 3)).rejects.toThrow("byte limit");
  let cancelled = false;
  const controller = new AbortController();
  const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
  const pending = readResponseText(response, 10, controller.signal);
  controller.abort(new Error("body cancelled"));
  await expect(pending).rejects.toThrow("body cancelled"); expect(cancelled).toBe(true);
});

test("extraction keeps Readability metadata, absolute links, Markdown and the existing response format", async () => {
  const page = await extractWebPage({ url: "https://example.com/article" }, { fetch: async (_url, init) => {
    expect(init?.redirect).toBe("follow"); return htmlResponse(article);
  } });
  expect(page.title).toBe("Readable article"); expect(page.siteName).toBe("Example Site"); expect(page.byline).toBe("Example Author");
  expect(page.content).toContain("[reference](https://example.com/reference)");
  expect(page.content).toContain("More details"); expect(page.content).toContain("const value = 1;");
  expect(page.content).not.toContain("Navigation only"); expect(page.content).not.toContain("Footer only");
  expect(page.truncated).toBe(false);
  const text = extractedPageMarkdown(page);
  expect(text).toStartWith("# Readable article\n\nURL: https://example.com/article");
  expect(text).toContain("Site: Example Site"); expect(text).toContain("Byline: Example Author"); expect(text).toContain("---");
});

test("extraction uses the redirected document URL and truncates the body at the requested length", async () => {
  const response = htmlResponse(article);
  Object.defineProperty(response, "url", { value: "https://final.example/article" });
  const page = await extractWebPage({ url: "https://example.com/redirect", maxChars: 1000 }, { fetch: async () => response });
  expect(page.finalUrl).toBe("https://final.example/article"); expect(page.truncated).toBe(true);
  expect(page.content).toEndWith("[...truncated to 1000 chars]");
  expect(extractedPageMarkdown(page)).toContain("URL: https://final.example/article");
  expect(extractedPageMarkdown(page)).toContain("Content: truncated");
});

test("fallback extraction handles short pages without executing scripts or fetching subresources", async () => {
  delete (globalThis as Record<string, unknown>).webExtractionScriptRan;
  const page = await extractWebPage({ url: "https://example.com/short" }, { fetch: async () => htmlResponse('<html><head><title>Short page</title></head><body>Short content<script>globalThis.webExtractionScriptRan=true;document.body.textContent="Script executed"</script><iframe src="https://example.com/frame"></iframe></body></html>') });
  expect(page.content).toBe("Short content"); expect((globalThis as Record<string, unknown>).webExtractionScriptRan).toBeUndefined();
});

test("extraction rejects invalid protocols, non-HTML, HTTP failures and oversized HTML", async () => {
  let calls = 0; const fetch: WebFetch = async () => { calls++; return htmlResponse(article); };
  for (const url of ["", "not a URL", "file:///etc/passwd", "data:text/html,test"]) await expect(extractWebPage({ url }, { fetch })).rejects.toThrow("url must");
  expect(calls).toBe(0);
  await expect(extractWebPage({ url: "https://example.com" }, { fetch: async () => new Response("{}", { headers: { "Content-Type": "application/json" } }) })).rejects.toThrow("did not return HTML");
  await expect(extractWebPage({ url: "https://example.com" }, { fetch: async () => new Response("not found", { status: 404 }) })).rejects.toThrow("HTTP 404");
  await expect(extractWebPage({ url: "https://example.com" }, { fetch: async () => htmlResponse("x".repeat(8 * 1024 * 1024 + 1)) })).rejects.toThrow("byte limit");
});

test("the Durable adapter forwards context cancellation and preserves extraction details", async () => {
  const web = createWebTools({ BRAVE_SEARCH_API_KEY: KEY }, { fetch: async () => htmlResponse(article) });
  const extract = web.extension.tools!.find(tool => tool.name === "web_extract")!;
  const result = await extract.execute({ url: "https://example.com/article", maxChars: 1000 }, {} as never, context);
  expect(result.content?.[0]).toMatchObject({ type: "text" });
  expect(result.details).toMatchObject({ url: "https://example.com/article", maxChars: 1000, page: { truncated: true } });
  const cancel = new AbortController(); cancel.abort(new Error("context cancelled"));
  await expect(extract.execute({ url: "https://example.com/article" }, {} as never, withAbortSignal(cancel.signal, context))).rejects.toThrow("context cancelled");
});
