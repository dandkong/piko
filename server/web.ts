import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type WebHandler = (request: Request) => Promise<Response>;

/** Serve only the exported public directory; data and source trees are never web roots. */
export async function createWebHandler(directory: string): Promise<WebHandler> {
  let root: string;
  try {
    root = await realpath(directory);
    if (!(await stat(join(root, "index.html"))).isFile()) throw new Error("Missing index.html");
  } catch {
    throw new Error("Web build is missing. Run bun run build:web before bun run start.");
  }

  const missing = () => new Response("Not found.", { status: 404 });
  async function fileResponse(path: string, request: Request): Promise<Response> {
    let canonical: string;
    let info;
    try {
      canonical = await realpath(path);
      const scope = relative(root, canonical);
      if (isAbsolute(scope) || scope === ".." || scope.startsWith(`..${sep}`)) return missing();
      info = await stat(canonical);
      if (!info.isFile()) return missing();
    } catch { return missing(); }
    const file = Bun.file(canonical);
    const fingerprinted = /(?:^|[-.])[a-f0-9]{16,}\./i.test(path);
    const etag = `"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
    const headers = new Headers({
      "Content-Type": file.type,
      "Cache-Control": fingerprinted ? "public, max-age=31536000, immutable" : "no-cache",
      "ETag": etag,
      "X-Content-Type-Options": "nosniff",
    });
    if (request.headers.get("if-none-match")?.split(",").map(value => value.trim()).includes(etag)) {
      return new Response(null, { status: 304, headers });
    }
    headers.set("Content-Length", String(info.size));
    return new Response(request.method === "HEAD" ? null : file, { headers });
  }

  return async request => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed.", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); }
    catch { return new Response("Invalid path.", { status: 400 }); }
    if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").some(part => part.startsWith("."))) return missing();
    if (/^\/api(?:\/|$)/.test(pathname)) return missing();
    const path = resolve(root, `.${pathname}`);
    const response = await fileResponse(pathname === "/" ? join(root, "index.html") : path, request);
    if (response.status !== 404) return response;
    // SPA navigation may return index; missing scripts/images and API paths must keep their 404.
    if (!extname(pathname) && !/^\/(?:api|_expo|assets)(?:\/|$)/.test(pathname)
      && request.headers.get("accept")?.includes("text/html")) return fileResponse(join(root, "index.html"), request);
    return response;
  };
}
