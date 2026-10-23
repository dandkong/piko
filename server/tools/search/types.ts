import { WebRequestError } from "../http";

export const SEARCH_PROVIDER_IDS = ["exa", "tavily", "deepseek", "brave"] as const;
export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];

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
  supports(query: string): boolean;
  search(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]>;
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
