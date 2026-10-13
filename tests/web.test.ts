import { expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWebHandler } from "../server/web";
import { createApp } from "../server/app";
import { ConversationStore } from "../server/chat/conversations";
import { defaultServerConfig } from "../server/config";
import { fixture, cleanup } from "./fixtures/durable";
import { consumeSse } from "../shared/sse";

async function site() {
  const f = await fixture(); const root = join(f.root, "web");
  await mkdir(join(root, "_expo/static/js/web"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><title>Piko</title>");
  const asset = "/_expo/static/js/web/index-0123456789abcdef0123456789abcdef.js";
  await writeFile(join(root, asset), "console.log('Piko');");
  return { ...f, exportRoot: root, asset, web: await createWebHandler(root) };
}
const request = (path: string, init?: RequestInit) => new Request(`http://piko.test${path}`, init);

test("exported HTML and fingerprinted assets have correct MIME, cache, HEAD and validation behavior", async () => {
  const f = await site();
  const html = await f.web(request("/"));
  expect(await html.text()).toContain("<title>Piko</title>");
  expect(html.headers.get("content-type")).toContain("text/html");
  expect(html.headers.get("cache-control")).toBe("no-cache");
  const asset = await f.web(request(f.asset));
  expect(asset.headers.get("content-type")).toContain("javascript");
  expect(asset.headers.get("cache-control")).toContain("immutable");
  const etag = asset.headers.get("etag")!;
  expect(await asset.text()).toContain("console.log");
  const head = await f.web(request(f.asset, { method: "HEAD" }));
  expect(await head.text()).toBe("");
  expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);
  const unchanged = await f.web(request(f.asset, { headers: { "if-none-match": etag } }));
  expect(unchanged.status).toBe(304); expect(await unchanged.text()).toBe("");
});

test("SPA fallback never disguises a missing asset or API route as HTML", async () => {
  const f = await site(); const navigation = { headers: { accept: "text/html" } };
  expect(await (await f.web(request("/chat", navigation))).text()).toContain("<title>Piko</title>");
  for (const path of ["/missing.js", "/assets/missing", "/_expo/missing", "/api", "/api/chat"]) {
    expect((await f.web(request(path, navigation))).status).toBe(404);
  }
  expect((await f.web(request("/", { method: "POST" }))).status).toBe(405);
});

test("encoded traversal, hidden files and links outside the export cannot expose local data", async () => {
  const f = await site(); const privateRoot = join(f.root, "private"); await mkdir(privateRoot);
  await writeFile(join(privateRoot, "secret.txt"), "PRIVATE");
  await writeFile(join(f.exportRoot, ".env"), "PRIVATE");
  await symlink(privateRoot, join(f.exportRoot, "link"), process.platform === "win32" ? "junction" : "dir");
  for (const path of ["/%2f..%2fprivate/secret.txt", "/%5c..%5cprivate/secret.txt", "/.env", "/%2eenv", "/link/secret.txt", "/%00"]) {
    const response = await f.web(request(path));
    expect(response.status).toBe(404); expect(await response.text()).not.toContain("PRIVATE");
  }
  expect((await f.web(request("/%zz"))).status).toBe(400);
});

test("one listener serves Web, API and persistent SSE with permissive CORS", async () => {
  const f = await site(); const store = new ConversationStore(f.runtime); cleanup(() => store.close());
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createApp({ config: defaultServerConfig(), runtime: f.runtime, conversations: store, web: f.web }) });
  cleanup(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  expect(await (await fetch(base)).text()).toContain("<title>Piko</title>");
  const health = await fetch(`${base}/api/health`, { headers: { origin: base } });
  expect(health.status).toBe(200); expect((await health.json()).app).toBe("Piko");
  const crossOrigin = await fetch(`${base}/api/health`, { headers: { origin: "https://other.test" } });
  expect(crossOrigin.status).toBe(200);
  expect(crossOrigin.headers.get("Access-Control-Allow-Origin")).toBe("https://other.test");
  expect((await fetch(`${base}/api/missing`, { headers: { accept: "text/html" } })).status).toBe(404);
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/chat/events`, { signal: controller.signal, headers: { origin: base } });
  expect(stream.headers.get("content-type")).toBe("text/event-stream");
  const reader = stream.body!.getReader();
  try { expect(consumeSse(new TextDecoder().decode((await reader.read()).value)).events[0].type).toBe("snapshot"); }
  finally { controller.abort(); await reader.cancel().catch(() => {}); }
});

test("the production web entry fails clearly when its build is missing", async () => {
  const f = await fixture();
  await expect(createWebHandler(join(f.root, "missing"))).rejects.toThrow("bun run build:web");
});
