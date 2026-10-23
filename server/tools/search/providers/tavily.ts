import { requestJson, record, text, httpUrl } from "../request";
import type { ProviderOptions, SearchProvider, SearchResult } from "../types";

export function createTavilyProvider(options: ProviderOptions): SearchProvider {
  return {
    id: "tavily",
    supports: () => true,
    async search(query, count, signal): Promise<SearchResult[]> {
      const data = await requestJson("tavily", "https://api.tavily.com/search", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ query, max_results: count, search_depth: "basic", include_answer: false, include_raw_content: false }),
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
