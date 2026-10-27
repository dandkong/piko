import type { RichBlock, RichText } from "grammy/types";
import { LONG_TEXT_LIMIT, truncateText } from "../../runtime/text";

function richTextToPlainText(value: RichText): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(richTextToPlainText).join("");
  if ("text" in value) return richTextToPlainText(value.text);
  if (value.type === "custom_emoji") return value.alternative_text;
  if (value.type === "mathematical_expression") return value.expression;
  return "";
}

function richBlockToPlainText(block: RichBlock): string {
  switch (block.type) {
    case "paragraph": case "heading": case "pre": case "footer":
      return richTextToPlainText(block.text);
    case "mathematical_expression":
      return block.expression;
    case "blockquote": case "collage": case "slideshow":
      return richBlocksToPlainText(block.blocks);
    case "expandable_blockquote": case "pullquote":
      return richTextToPlainText(block.text);
    case "list":
      return block.items.map(item => [item.label, richBlocksToPlainText(item.blocks)].filter(Boolean).join(" ")).join("\n");
    case "table":
      return block.cells.map(row => row.map(cell => cell.text ? richTextToPlainText(cell.text) : "").join(" | ")).join("\n");
    case "details":
      return [richTextToPlainText(block.summary), richBlocksToPlainText(block.blocks)].filter(Boolean).join("\n\n");
    default:
      return "";
  }
}

export function richBlocksToPlainText(blocks: readonly RichBlock[]): string {
  return blocks.map(richBlockToPlainText).filter(Boolean).join("\n\n");
}

/** Add a bounded Telegram reply as Markdown context without storing a second message body. */
export function withTelegramQuote(messageText: string, replyText?: string): string {
  const text = messageText.trim();
  const quote = replyText?.replace(/\r\n?/g, "\n").trim();
  if (!quote) return text;

  const excerpt = truncateText(quote, LONG_TEXT_LIMIT, "…");
  const blockquote = excerpt.split("\n").map(line => `> ${line}`).join("\n");
  return `${blockquote}${text ? `\n\n${text}` : ""}`;
}
