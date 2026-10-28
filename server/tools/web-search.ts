import { WebRequestError } from "./http";
import {
  SEARCH_FRESHNESS,
  SEARCH_SNIPPET_MAX,
  type SearchFilters,
  type SearchFreshness,
  type SearchProvider,
  type SearchResult,
} from "./search/types";

export type SearchArguments = {
  query: string;
  maxResults?: number;
  freshness?: SearchFreshness;
  includeDomains?: string[];
  excludeDomains?: string[];
};
export type SearchOptions = { providers: readonly SearchProvider[] };

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
  const filters = normalizeFilters(args);

  // Skip backends that cannot honor the filters instead of silently returning content outside them.
  const capable = options.providers.filter(provider => provider.supports(query, filters));
  if (!capable.length) throw new WebRequestError(options.providers.some(provider => provider.supports(query, {}))
    ? "Configured search backends do not support the requested freshness or domain filters."
    : "The search query exceeds the limits of configured search backends.");

  for (const provider of capable) {
    signal?.throwIfAborted();
    try {
      const results = (await provider.search(query, count, filters, signal)).slice(0, count);
      // Empty is a successful answer: do not fan a single query out to more paid providers.
      return formatResults(results);
    } catch {
      signal?.throwIfAborted();
      // The adapter deliberately hides upstream details. Try the next configured backend.
    }
  }
  throw new WebRequestError("Web search could not complete. Configured search providers are unavailable.");
}

function normalizeFilters(args: SearchArguments): SearchFilters {
  const rawArgs = args as SearchArguments & Record<string, unknown>;
  if (Object.hasOwn(rawArgs, "publishedAfter") || Object.hasOwn(rawArgs, "publishedBefore"))
    throw new WebRequestError("Date-range filters are not supported; use freshness: day, week, month, or year.");
  const freshness = args.freshness;
  if (freshness !== undefined && !(SEARCH_FRESHNESS as readonly string[]).includes(freshness))
    throw new WebRequestError("freshness must be day, week, month, or year.");
  const includeDomains = domainArgument(args.includeDomains, "includeDomains");
  const excludeDomains = domainArgument(args.excludeDomains, "excludeDomains");
  return {
    ...(freshness && { freshness }),
    ...(includeDomains.length && { includeDomains }),
    ...(excludeDomains.length && { excludeDomains }),
  };
}

function domainArgument(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new WebRequestError(`${name} must be an array of hostnames.`);
  const unique = new Set<string>();
  for (const entry of value) {
    const hostname = typeof entry === "string" ? normalizeHostname(entry) : undefined;
    if (!hostname) throw new WebRequestError(`${name} must contain hostnames such as example.com.`);
    unique.add(hostname);
  }
  if (unique.size > 5) throw new WebRequestError(`${name} accepts at most 5 domains.`);
  return [...unique];
}

function normalizeHostname(value: string): string | undefined {
  const raw = value.trim().toLowerCase();
  // Accept only a bare hostname. URL parsing alone would silently discard a supplied
  // path/query or normalize default ports, widening the requested source scope.
  if (!raw || /[\\/:?#@\\s]/.test(raw)) return undefined;
  try {
    const url = new URL(`https://${raw}`);
    const hostname = url.hostname;
    return !url.username && !url.password && !url.port && url.pathname === "/" && !url.search && !url.hash
      && hostname.length <= 253
      && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)
      ? hostname
      : undefined;
  } catch { return undefined; }
}

function formatResults(results: readonly SearchResult[]): string {
  if (!results.length) return "No results found.";
  return ["Results:", ...results.map((item, index) => {
    const snippet = truncate(item.snippet ?? "", SEARCH_SNIPPET_MAX);
    const published = item.publishedAt ? `\n   Published: ${item.publishedAt}` : "";
    return `${index + 1}. ${item.title}\n   ${item.url}${published}${snippet ? `\n   ${snippet}` : ""}`;
  })].join("\n");
}

function truncate(value: string, length: number) {
  return value.length <= length ? value : `${value.slice(0, length)}... [truncated ${value.length - length} chars]`;
}
