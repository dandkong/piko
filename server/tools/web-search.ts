import { WebRequestError } from "./http";
import { codePointLength, sliceCodePoints } from "../text";
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

  // Providers omit unsupported filters; an overlong query is never silently truncated.
  const capable = options.providers.filter(provider => provider.supports(query));
  if (!capable.length) throw new WebRequestError("The search query exceeds the limits of configured search backends.");

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
  return {
    ...(freshness && { freshness }),
    ...(args.includeDomains !== undefined && { includeDomains: args.includeDomains }),
    ...(args.excludeDomains !== undefined && { excludeDomains: args.excludeDomains }),
  };
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
  const total = codePointLength(value);
  if (total <= length) return value;
  const marker = "…";
  const bodyLimit = Math.max(0, length - codePointLength(marker));
  return `${sliceCodePoints(value, bodyLimit)}${marker}`;
}
