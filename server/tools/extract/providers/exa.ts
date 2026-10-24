import { WebRequestError } from "../../http";
import { httpUrl, record, requestJson, text } from "./request";
import type { ProviderRequestOptions, WebExtractProvider } from "./types";

const EXA_CONTENTS_URL = "https://api.exa.ai/contents";

export function createExaExtractProvider(options: ProviderRequestOptions): WebExtractProvider {
  return {
    id: "exa",
    async extract(url, maxChars, signal) {
      const response = await requestJson("exa", EXA_CONTENTS_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ ids: [url], text: { maxCharacters: maxChars } }),
      }, options, signal);
      const results = response.results;
      if (!Array.isArray(results)) throw new WebRequestError("Exa returned no page results.");
      const wanted = httpUrl(url);
      const result = results.map(record).find(item => httpUrl(item?.url) === wanted) ?? record(results[0]);
      const content = text(result?.text);
      if (!content) throw new WebRequestError("Exa returned no readable content.");
      return {
        title: text(result?.title),
        content,
        finalUrl: httpUrl(result?.url) ?? url,
        byline: text(result?.author),
        excerpt: text(result?.summary),
      };
    },
  };
}
