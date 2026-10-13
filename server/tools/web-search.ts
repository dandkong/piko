import { readResponseText, WebRequestError, withRequestSignal, type WebFetch } from "./http";

const SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const RESPONSE_BYTES = 1024 * 1024;
export type SearchArguments = { query: string; maxResults?: number };
export type SearchOptions = { apiKey?: string; fetch?: WebFetch; timeoutMs?: number };

/** Provider-specific implementation stays behind the provider-neutral tool. */
export async function searchWeb(args: SearchArguments, options: SearchOptions, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const key = options.apiKey?.trim();
  if (!key) throw new WebRequestError("Web search is not configured on this backend. Ask the administrator to configure search credentials.");
  const query = args.query.trim();
  if (!query || ["none", "null", "undefined"].includes(query.toLowerCase())) throw new WebRequestError("query is required.");
  const count = Number.isFinite(args.maxResults) ? Math.max(1, Math.min(10, Math.floor(args.maxResults!))) : 5;
  const url = new URL(SEARCH_URL); url.searchParams.set("q", query); url.searchParams.set("count", String(count));
  return withRequestSignal(signal, options.timeoutMs ?? 15000, "Web search", async signal => {
    const response = await (options.fetch ?? fetch)(url, { method: "GET", redirect: "error", signal,
      headers: { Accept: "application/json", "X-Subscription-Token": key } });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new WebRequestError("Web search authentication failed. Ask the administrator to check search credentials.");
      if (response.status === 429) throw new WebRequestError("Web search is temporarily rate limited. Try again later.");
      throw new WebRequestError(`Web search request failed (HTTP ${response.status}).`);
    }
    const text = await readResponseText(response, RESPONSE_BYTES, signal);
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new WebRequestError("Web search returned an invalid response."); }
    // Never return raw provider JSON or an upstream error body, even on HTTP 200.
    if (!object(data) || data.error || data.errors) throw new WebRequestError("Web search returned an invalid response.");
    const web = object(data.web) ? data.web : undefined;
    if (web?.results !== undefined && !Array.isArray(web.results)) throw new WebRequestError("Web search returned an invalid response.");
    const results = (Array.isArray(web?.results) ? web.results : []).filter(object).slice(0, count);
    const lines: string[] = [];
    const altered = object(data.query) ? string(data.query.altered) : undefined;
    if (altered) lines.push(`Altered query: ${altered}`, "");
    if (!results.length) lines.push("No results found.");
    else {
      lines.push("Results:");
      results.forEach((item, index) => {
        const title = string(item.title) || "Untitled"; const link = string(item.url);
        const description = string(item.description) || string(item.snippet);
        const extras = Array.isArray(item.extra_snippets) ? item.extra_snippets.filter((item): item is string => typeof item === "string") : [];
        const snippet = [description, ...extras].filter(Boolean).join("\n   ");
        lines.push(`${index + 1}. ${title}${link ? `\n   ${link}` : ""}${snippet ? `\n   ${truncate(snippet, 1200)}` : ""}`);
      });
    }
    return lines.join("\n").replaceAll(key, "[redacted]");
  });
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
function truncate(value: string, length: number) {
  return value.length <= length ? value : `${value.slice(0, length)}... [truncated ${value.length - length} chars]`;
}
