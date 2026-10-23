import MarkdownIt from "markdown-it";
import markdownItCjkFriendly from "markdown-it-cjk-friendly";
import remend from "remend";

export const assistantMarkdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
}).use(markdownItCjkFriendly);

// Completion is only for the active reply's display, never for stored content.
export function prepareAssistantMarkdown(content: string, streaming: boolean): string {
  return streaming ? remend(content, {
    linkMode: "text-only",
    katex: false,
    htmlTags: false,
    comparisonOperators: false,
  }) : content;
}

export function isAssistantLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !!parsed.hostname;
  } catch {
    return false;
  }
}
