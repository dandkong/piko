import { requestJson, record, text, httpUrl } from "../request";
import type { ProviderOptions, SearchProvider, SearchResult } from "../types";

export function createTavilyProvider(options: ProviderOptions): SearchProvider {
  return {
    id: "tavily",
    supports: () => true,
    async search(query, count, filters, signal): Promise<SearchResult[]> {
      const body: Record<string, unknown> = {
        query, max_results: count, search_depth: "basic", include_answer: false, include_raw_content: false,
        // Without this Tavily omits published_date, so callers cannot judge freshness.
        include_published_date: true,
      };
      if (filters.freshness) body.time_range = filters.freshness;
      if (filters.publishedAfter) body.start_date = filters.publishedAfter;
      if (filters.publishedBefore) body.end_date = filters.publishedBefore;
      // start_date/end_date/time_range alone only influence ranking; strict filtering removes out-of-window pages.
      if (filters.freshness || filters.publishedAfter || filters.publishedBefore) body.filter_by_published_date = true;
      if (filters.includeDomains?.length) body.include_domains = [...filters.includeDomains];
      if (filters.excludeDomains?.length) body.exclude_domains = [...filters.excludeDomains];
      const data = await requestJson("tavily", "https://api.tavily.com/search", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify(body),
      }, options, signal);
      const results = record(data)?.results;
      if (!Array.isArray(results)) throw new Error("Invalid Tavily search response.");
      const normalized: SearchResult[] = [];
      for (const value of results) {
        const item = record(value), url = httpUrl(item?.url);
        if (!url) continue;
        const snippet = text(item?.content), publishedAt = text(item?.published_date) ?? text(item?.publishedDate);
        normalized.push({ title: text(item?.title) ?? "Untitled", url,
          ...(snippet && { snippet }), ...(publishedAt && { publishedAt }) });
      }
      return normalized.slice(0, count);
    },
  };
}
