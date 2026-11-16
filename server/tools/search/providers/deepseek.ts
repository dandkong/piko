import { requestJson, record, text, httpUrl } from "../request";
import type { ProviderOptions, SearchProvider, SearchResult } from "../types";

const SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
export function createDeepSeekProvider(options: ProviderOptions): SearchProvider {
  return {
    id: "deepseek",
    // Unsupported filters are omitted; never truncate a query to fit the 128-character limit.
    supports: query => [...query].length <= 128,
    async search(query, count, _filters, signal): Promise<SearchResult[]> {
      const data = await requestJson("deepseek", SEARCH_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ query, count, need_content: false }),
      }, options, signal);
      const results = record(data)?.results;
      if (!Array.isArray(results)) throw new Error("Invalid DeepSeek search response.");
      const normalized: SearchResult[] = [];
      for (const value of results) {
        const item = record(value), url = httpUrl(item?.url);
        if (!url) continue;
        const snippet = text(item?.summary) ?? text(item?.snippet), publishedAt = text(item?.date);
        normalized.push({ title: text(item?.title) ?? "Untitled", url,
          ...(snippet && { snippet }), ...(publishedAt && { publishedAt }) });
      }
      return normalized.slice(0, count);
    },
  };
}
