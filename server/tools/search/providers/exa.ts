import { requestJson, record, text, httpUrl } from "../request";
import { SEARCH_SNIPPET_MAX, type ProviderOptions, type SearchProvider, type SearchResult } from "../types";

export function createExaProvider(options: ProviderOptions): SearchProvider {
  return {
    id: "exa",
    supports: () => true,
    async search(query, count, signal): Promise<SearchResult[]> {
      const data = await requestJson("exa", "https://api.exa.ai/search", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ query, type: "auto", numResults: count, contents: { highlights: { maxCharacters: SEARCH_SNIPPET_MAX } } }),
      }, options, signal);
      const results = record(data)?.results;
      if (!Array.isArray(results)) throw new Error("Invalid Exa search response.");
      const normalized: SearchResult[] = [];
      for (const value of results) {
        const item = record(value), url = httpUrl(item?.url);
        if (!url) continue;
        const highlights = Array.isArray(item?.highlights) ? item.highlights.map(text).filter((v): v is string => !!v) : [];
        const snippet = highlights.length ? highlights.join("\n") : text(item?.text);
        const publishedAt = text(item?.publishedDate);
        normalized.push({ title: text(item?.title) ?? "Untitled", url,
          ...(snippet && { snippet }), ...(publishedAt && { publishedAt }) });
      }
      return normalized.slice(0, count);
    },
  };
}
