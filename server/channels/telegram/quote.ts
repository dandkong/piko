import { LONG_TEXT_LIMIT, truncateText } from "../../runtime/text";

const QUOTE_HEADER = "Quoted Telegram message (context; truncated if long):";

/** Add a bounded Telegram reply as Markdown context without storing a second message body. */
export function withTelegramQuote(messageText: string, replyText?: string): string {
  const text = messageText.trim();
  const quote = replyText?.replace(/\r\n?/g, "\n").trim();
  if (!quote) return text;

  const excerpt = truncateText(quote, LONG_TEXT_LIMIT, "…");
  const blockquote = excerpt.split("\n").map(line => `> ${line}`).join("\n");
  return `${QUOTE_HEADER}\n${blockquote}${text ? `\n\n${text}` : ""}`;
}
