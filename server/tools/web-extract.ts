import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { readResponseText, WebRequestError, withRequestSignal, type WebFetch } from "./http";

export type ExtractedPage = {
  url: string; finalUrl?: string; title: string; byline?: string | null;
  siteName?: string | null; excerpt?: string | null; length?: number;
  content: string; truncated: boolean; contentType?: string;
};
export type ExtractArguments = { url: string; maxChars?: number };
export type ExtractOptions = { fetch?: WebFetch; timeoutMs?: number };
const DEFAULT_MAX_CHARS = 10000;
const MAX_CHARS = 100000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function clampMaxChars(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_MAX_CHARS;
  return Math.max(1000, Math.min(MAX_CHARS, Math.floor(value!)));
}
function truncate(value: string, maxChars: number): { text: string; truncated: boolean } {
  return value.length <= maxChars ? { text: value, truncated: false }
    : { text: `${value.slice(0, maxChars)}\n\n[...truncated to ${maxChars} chars]`, truncated: true };
}
function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function normalizeUrl(raw: string): string {
  if (typeof raw !== "string" || !raw.trim()) throw new WebRequestError("url must be a non-empty URL string.");
  let parsed: URL;
  try { parsed = new URL(raw.trim()); } catch { throw new WebRequestError("url must be a valid HTTP or HTTPS URL."); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new WebRequestError("url must use http or https.");
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

/** Same Readability → Markdown projection as the existing web_extract tool.
 * HTML is parsed only: scripts and subresources are not enabled.
 */
export async function extractWebPage(args: ExtractArguments, options: ExtractOptions = {}, signal?: AbortSignal): Promise<ExtractedPage> {
  signal?.throwIfAborted();
  const url = normalizeUrl(args.url); const maxChars = clampMaxChars(args.maxChars);
  const fetched = await fetchHtml(url, options, signal);
  signal?.throwIfAborted();
  const dom = new JSDOM(fetched.html, { url: fetched.finalUrl || url });
  try {
    const reader = new Readability(dom.window.document.cloneNode(true) as Document);
    const article = reader.parse();
    let page: Omit<ExtractedPage, "content" | "truncated">; let content: string;
    if (article) {
      page = { url, finalUrl: fetched.finalUrl, title: article.title || dom.window.document.title || "Untitled page",
        byline: article.byline, siteName: article.siteName, excerpt: article.excerpt, length: article.length ?? undefined, contentType: fetched.contentType };
      content = normalizeWhitespace(NodeHtmlMarkdown.translate(article.content || ""));
    } else {
      const fallback = extractFallback(dom.window.document);
      page = { url, finalUrl: fetched.finalUrl, title: fallback.title, contentType: fetched.contentType };
      content = fallback.content;
    }
    signal?.throwIfAborted();
    const result = truncate(content, maxChars);
    return { ...page, content: result.text, truncated: result.truncated };
  } finally { dom.window.close(); }
}

export function extractedPageMarkdown(page: ExtractedPage): string {
  const lines = [`# ${page.title || "Untitled page"}`, "", `URL: ${page.finalUrl || page.url}`];
  if (page.siteName) lines.push(`Site: ${page.siteName}`);
  if (page.byline) lines.push(`Byline: ${page.byline}`);
  if (page.excerpt) lines.push(`Excerpt: ${page.excerpt}`);
  if (page.truncated) lines.push("Content: truncated");
  lines.push("", "---", "", page.content || "No readable content extracted.");
  return lines.join("\n");
}
