import { WebRequestError } from "../http";
import { EXTERNAL_SOURCE_EXCERPT_MAX_CHARS } from "../text-limits";

export const SEARCH_PROVIDER_IDS = ["exa", "tavily", "deepseek", "brave"] as const;
export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];

/** Per-result excerpt budget shared by provider requests and the tool's output formatter. */
export const SEARCH_SNIPPET_MAX = EXTERNAL_SOURCE_EXCERPT_MAX_CHARS;

export const SEARCH_FRESHNESS = ["day", "week", "month", "year"] as const;
export type SearchFreshness = (typeof SEARCH_FRESHNESS)[number];
const FRESHNESS_DAYS: Record<SearchFreshness, number> = { day: 1, week: 7, month: 30, year: 365 };

/** Relative recency and domain filters; providers without native support are skipped by the tool. */
export type SearchFilters = {
  freshness?: SearchFreshness;
  includeDomains?: readonly string[];
  excludeDomains?: readonly string[];
};

export function hasFreshnessFilter(filters: SearchFilters): boolean {
  return !!filters.freshness;
}

export function hasDomainFilters(filters: SearchFilters): boolean {
  return !!(filters.includeDomains?.length || filters.excludeDomains?.length);
}

export function freshnessStartIso(freshness: SearchFreshness, now = Date.now()): string {
  return new Date(now - FRESHNESS_DAYS[freshness] * 86_400_000).toISOString();
}

/** Provider-neutral subset consumed by the single web_search tool. */
export type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
};

/** Small seam for adding/removing a backend; no plugin lifecycle or provider config object. */
export type SearchProvider = {
  id: SearchProviderId;
  supports(query: string, filters: SearchFilters): boolean;
  search(query: string, count: number, filters: SearchFilters, signal?: AbortSignal): Promise<SearchResult[]>;
};

export type ProviderOptions = {
  apiKey: string;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
};

/** Safe failure metadata for fallback and operational tests; never carries request data or credentials. */
export class SearchProviderFailure extends WebRequestError {
  constructor(readonly provider: SearchProviderId, readonly status?: number) {
    super("Search provider request failed.");
  }
}
