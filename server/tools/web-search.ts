import { WebRequestError } from "./http";
import type { SearchProvider, SearchResult } from "./search/types";

export type SearchArguments = { query: string; maxResults?: number };
export type SearchOptions = { providers: readonly SearchProvider[]; redact?: readonly string[] };

/** One provider-neutral search entry point. Backends are tried sequentially by JSON priority. */
export async function searchWeb(
  args: SearchArguments,
  options: SearchOptions,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const query = args.query.trim();
  if (!query || ["none", "null", "undefined"].includes(query.toLowerCase()))
    throw new WebRequestError("query is required.");
  const count = Number.isFinite(args.maxResults)
    ? Math.max(1, Math.min(10, Math.floor(args.maxResults!)))
    : 5;
  if (!options.providers.length)
    throw new WebRequestError("Web search is not configured on this backend. Ask the administrator to configure search credentials.");

  let supported = false;
  for (const provider of options.providers) {
    signal?.throwIfAborted();
    if (!provider.supports(query)) continue;
    supported = true;
    try {
      const results = (await provider.search(query, count, signal)).slice(0, count);
      // Empty is a successful answer: do not fan a single query out to more paid providers.
      return formatResults(results, options.redact ?? []);
    } catch {
      signal?.throwIfAborted();
      // The adapter deliberately hides upstream details. Try the next configured backend.
    }
  }
  if (!supported)
    throw new WebRequestError("The search query exceeds the limits of configured search backends.");
  throw new WebRequestError("Web search could not complete. Configured search providers are unavailable.");
}

function formatResults(results: readonly SearchResult[], secrets: readonly string[]): string {
  if (!results.length) return "No results found.";
  const redact = (value: string) => secrets.reduce((text, secret) => secret ? text.replaceAll(secret, "[redacted]") : text, value);
  return ["Results:", ...results.map((item, index) => {
    const snippet = truncate(item.snippet ?? "", 1200);
    const published = item.publishedAt ? `\n   Published: ${item.publishedAt}` : "";
    return `${index + 1}. ${redact(item.title)}\n   ${redact(item.url)}${published}${snippet ? `\n   ${redact(snippet)}` : ""}`;
  })].join("\n");
}

function truncate(value: string, length: number) {
  return value.length <= length ? value : `${value.slice(0, length)}... [truncated ${value.length - length} chars]`;
}
