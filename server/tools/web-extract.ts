import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { readResponseText, WebRequestError, withRequestSignal, type WebFetch } from "./http";
import type { ProviderRegistry, WebExtractProviderId } from "./extract/providers/types";
import { httpUrl } from "./extract/providers/request";
import { EXTERNAL_SOURCE_EXCERPT_MAX_CHARS } from "./text-limits";
import { codePointLength, sliceCodePoints } from "../text";

export type ExtractedPage = {
  url: string; finalUrl?: string; provider: WebExtractProviderId; title: string; byline?: string | null;
  siteName?: string | null; excerpt?: string | null; contentLength: number; readabilityLength?: number;
  content: string; truncated: boolean; contentType?: string;
};
export type ExtractArguments = { url: string; provider?: WebExtractProviderId };
export type ExtractOptions = { fetch?: WebFetch; timeoutMs?: number; providers?: ProviderRegistry };
const WEB_EXTRACT_MAX_CHARS = 10_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function boundedExcerpt(value: string | null | undefined): string | undefined {
  const excerpt = value?.trim();
  return excerpt ? sliceCodePoints(excerpt, EXTERNAL_SOURCE_EXCERPT_MAX_CHARS) : undefined;
}
function truncate(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (codePointLength(value) <= maxChars) return { text: value, truncated: false };
  const marker = `\n\n[...truncated to ${maxChars} chars]`;
  const contentLimit = Math.max(0, maxChars - codePointLength(marker));
  return { text: `${sliceCodePoints(value, contentLimit)}${marker}`, truncated: true };
}
function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function normalizeUrl(raw: string): string {
  if (typeof raw !== "string" || !raw.trim()) throw new WebRequestError("url must be a non-empty URL string.");
  let parsed: URL;
  try { parsed = new URL(raw.trim()); } catch { throw new WebRequestError("url must be a valid HTTP or HTTPS URL."); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new WebRequestError("url must use http or https.");
  if (parsed.username || parsed.password) throw new WebRequestError("URLs with embedded credentials are not supported.");
  return parsed.toString();
}

async function fetchHtml(url: string, options: ExtractOptions, signal?: AbortSignal) {
  return withRequestSignal(signal, options.timeoutMs ?? 15000, "Web extraction", async signal => {
    const response = await (options.fetch ?? fetch)(url, { redirect: "follow", signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; pi-web-extract/1.0)" } });
    if (!response.ok) { await response.body?.cancel(); throw new WebRequestError(`HTTP ${response.status} ${response.statusText}`.trim()); }
    const contentType = response.headers.get("content-type") || undefined;
    if (contentType && !contentType.toLowerCase().includes("html")) {
      await response.body?.cancel(); throw new WebRequestError(`URL did not return HTML content: ${contentType}`);
    }
    return { html: await readResponseText(response, MAX_RESPONSE_BYTES, signal), finalUrl: response.url || undefined, contentType };
  });
}

function extractFallback(document: Document): { title: string; content: string } {
  for (const selector of ["script", "style", "noscript", "svg", "iframe", "nav", "footer", "header"]) {
    document.querySelectorAll(selector).forEach(node => node.remove());
  }
  const title = document.querySelector("title")?.textContent?.trim() || "Untitled page";
  return { title, content: normalizeWhitespace(document.body?.textContent || document.documentElement.textContent || "") };
}

/** Local Readability → Markdown extraction. HTML is parsed only: scripts and subresources are not enabled. */
async function extractBuiltIn(url: string, maxChars: number, options: ExtractOptions, signal?: AbortSignal): Promise<ExtractedPage> {
  const fetched = await fetchHtml(url, options, signal);
  signal?.throwIfAborted();
  const dom = new JSDOM(fetched.html, { url: fetched.finalUrl || url });
  try {
    const reader = new Readability(dom.window.document.cloneNode(true) as Document);
    const article = reader.parse();
    let title: string; let content: string; let byline: string | null | undefined;
    let siteName: string | null | undefined; let excerpt: string | null | undefined;
    let readabilityLength: number | undefined;
    if (article) {
      title = article.title || dom.window.document.title || "Untitled page";
      byline = article.byline; siteName = article.siteName; excerpt = article.excerpt;
      readabilityLength = article.length ?? undefined;
      content = normalizeWhitespace(NodeHtmlMarkdown.translate(article.content || ""));
    } else {
      const fallback = extractFallback(dom.window.document);
      title = fallback.title; content = fallback.content;
    }
    signal?.throwIfAborted();
    const result = truncate(content, maxChars);
    return { url, finalUrl: fetched.finalUrl, provider: "built-in", title, byline, siteName,
      excerpt: boundedExcerpt(excerpt),
      content: result.text, contentLength: codePointLength(result.text), readabilityLength,
      truncated: result.truncated, contentType: fetched.contentType };
  } finally { dom.window.close(); }
}

async function extractRemote(url: string, providerId: Exclude<WebExtractProviderId, "built-in">, maxChars: number,
  options: ExtractOptions, signal?: AbortSignal): Promise<ExtractedPage> {
  const provider = options.providers?.get(providerId);
  if (!provider) throw new WebRequestError(`${providerId} is not configured on this backend.`);
  const result = await provider.extract(url, maxChars, signal);
  const content = normalizeWhitespace(result.content);
  if (!content) throw new WebRequestError(`${providerId} returned no readable content.`);
  const bounded = truncate(content, maxChars);
  const excerpt = result.excerpt?.trim();
  const finalUrl = httpUrl(result.finalUrl) ?? url;
  return { url, finalUrl, provider: providerId,
    title: result.title?.trim() || "Untitled page", byline: result.byline?.trim() || undefined,
    siteName: result.siteName?.trim() || undefined,
    excerpt: boundedExcerpt(excerpt),
    content: bounded.text, contentLength: codePointLength(bounded.text), truncated: bounded.truncated,
    contentType: "text/markdown" };
}

/** A call executes exactly one provider; the Agent may select another on a later call. */
export async function extractWebPage(args: ExtractArguments, options: ExtractOptions = {}, signal?: AbortSignal): Promise<ExtractedPage> {
  signal?.throwIfAborted();
  const url = normalizeUrl(args.url); const maxChars = WEB_EXTRACT_MAX_CHARS;
  const provider = args.provider ?? "built-in";
  return provider === "built-in"
    ? extractBuiltIn(url, maxChars, options, signal)
    : extractRemote(url, provider, maxChars, options, signal);
}

export function extractedPageMarkdown(page: ExtractedPage): string {
  const lines = [`# ${page.title || "Untitled page"}`, "", `URL: ${page.finalUrl || page.url}`, `Provider: ${page.provider}`,
    `Content characters: ${page.contentLength}`];
  if (page.siteName) lines.push(`Site: ${page.siteName}`);
  if (page.byline) lines.push(`Byline: ${page.byline}`);
  if (page.excerpt) lines.push(`Excerpt: ${page.excerpt}`);
  if (page.truncated) lines.push("Content: truncated");
  lines.push("", "---", "", page.content || "No readable content extracted.");
  return lines.join("\n");
}
