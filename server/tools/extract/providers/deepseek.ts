import { WebRequestError } from "../../http";
import { httpUrl, requestJson, text } from "./request";
import type { ProviderRequestOptions, WebExtractProvider } from "./types";

const DEEPSEEK_FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";

export function createDeepSeekExtractProvider(options: ProviderRequestOptions): WebExtractProvider {
  return {
    id: "deepseek",
    async extract(url, _maxChars, signal) {
      const response = await requestJson("deepseek", DEEPSEEK_FETCH_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ url }),
      }, options, signal);
      const content = text(response.content);
      if (!content) throw new WebRequestError("DeepSeek returned no readable content.");
      return {
        title: text(response.title),
        content,
        finalUrl: httpUrl(response.url) ?? url,
        siteName: text(response.site_name),
        byline: text(response.author),
        excerpt: text(response.description),
      };
    },
  };
}
