import { requestJson, record, text, httpUrl } from "../request";
import type { ProviderOptions, SearchProvider, SearchResult } from "../types";

const SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const FRESHNESS: Record<string, string> = { day: "pd", week: "pw", month: "pm", year: "py" };

export function createBraveProvider(options: ProviderOptions): SearchProvider {
  return {
    id: "brave",
    // Brave freshness is based on discovery time; unsupported domain filters are omitted.
    supports: () => true,
    async search(query, count, filters, signal): Promise<SearchResult[]> {
      const url = new URL(SEARCH_URL);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(count));
      if (filters.freshness) url.searchParams.set("freshness", FRESHNESS[filters.freshness]);
      const data = await requestJson("brave", url, {
        method: "GET",
        headers: { Accept: "application/json", "X-Subscription-Token": options.apiKey },
      }, options, signal);
      const results = record(record(data)?.web)?.results;
      if (!Array.isArray(results)) throw new Error("Invalid Brave search response.");
      const normalized: SearchResult[] = [];
      for (const value of results) {
        const item = record(value), url = httpUrl(item?.url);
        if (!url) continue;
        const extras = Array.isArray(item?.extra_snippets) ? item.extra_snippets.map(text).filter((v): v is string => !!v) : [];
        const snippet = [text(item?.description) ?? text(item?.snippet), ...extras].filter((v): v is string => !!v).join("\n");
        const publishedAt = text(item?.page_age) ?? text(item?.published_date);
        normalized.push({ title: text(item?.title) ?? "Untitled", url,
          ...(snippet && { snippet }), ...(publishedAt && { publishedAt }) });
      }
      return normalized.slice(0, count);
    },
  };
}
