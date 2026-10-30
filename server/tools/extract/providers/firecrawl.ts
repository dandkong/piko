import { WebRequestError } from "../../http";
import { httpUrl, record, requestJson, text } from "./request";
import type { ProviderRequestOptions, WebExtractProvider } from "./types";

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

export function createFirecrawlProvider(options: ProviderRequestOptions): WebExtractProvider {
  return {
    id: "firecrawl",
    async extract(url, signal) {
      const response = await requestJson("firecrawl", FIRECRAWL_SCRAPE_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      }, options, signal);
      const result = record(response.data);
      const metadata = record(result?.metadata);
      const content = text(result?.markdown);
      if (response.success === false || !content) throw new WebRequestError("Firecrawl returned no readable content.");
      return {
        title: text(metadata?.title) ?? text(result?.title),
        content,
        finalUrl: httpUrl(metadata?.sourceURL) ?? httpUrl(metadata?.url) ?? httpUrl(result?.url) ?? url,
        siteName: text(metadata?.ogSiteName) ?? text(metadata?.siteName),
        byline: text(metadata?.author) ?? text(metadata?.byline),
        excerpt: text(metadata?.description),
      };
    },
  };
}
