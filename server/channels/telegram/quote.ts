import type { RichBlock, RichBlockCaption, RichText, TextQuote } from "grammy/types";
import { truncateUtf16Text } from "../../runtime/text";
import { TELEGRAM_LONG_TEXT_LIMIT_UTF16 } from "./menu-policy";

function richTextToPlainText(value: RichText): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(richTextToPlainText).join("");
  if ("text" in value) return richTextToPlainText(value.text);
  if (value.type === "custom_emoji") return value.alternative_text;
  if (value.type === "mathematical_expression") return value.expression;
  return "";
}

function captionText(caption?: RichBlockCaption): string {
  if (!caption) return "";
  return [richTextToPlainText(caption.text), caption.credit && richTextToPlainText(caption.credit)].filter(Boolean).join("\n");
}

function richBlockToPlainText(block: RichBlock): string {
  switch (block.type) {
    case "paragraph": case "heading": case "pre": case "footer":
      return richTextToPlainText(block.text);
    case "mathematical_expression":
      return block.expression;
    case "blockquote":
      return [richBlocksToPlainText(block.blocks), block.credit && richTextToPlainText(block.credit)].filter(Boolean).join("\n");
    case "collage": case "slideshow":
      return [richBlocksToPlainText(block.blocks), captionText(block.caption)].filter(Boolean).join("\n");
    case "expandable_blockquote": {
      // Bot API 10.5 changed this block from `text` to nested `blocks`; installed types may lag.
      const current = block as unknown as { text?: RichText; blocks?: RichBlock[]; credit?: RichText };
      return [current.blocks ? richBlocksToPlainText(current.blocks) : current.text && richTextToPlainText(current.text),
        current.credit && richTextToPlainText(current.credit)].filter(Boolean).join("\n");
    }
    case "pullquote":
      return [richTextToPlainText(block.text), block.credit && richTextToPlainText(block.credit)].filter(Boolean).join("\n");
    case "list":
      return block.items.map(item => [item.label, richBlocksToPlainText(item.blocks)].filter(Boolean).join(" ")).join("\n");
    case "table":
      return [block.caption && richTextToPlainText(block.caption),
        block.cells.map(row => row.map(cell => cell.text ? richTextToPlainText(cell.text) : "").join(" | ")).join("\n")].filter(Boolean).join("\n");
    case "details":
      return [richTextToPlainText(block.summary), richBlocksToPlainText(block.blocks)].filter(Boolean).join("\n\n");
    case "map": case "animation": case "audio": case "document": case "photo": case "video": case "voice_note":
      return captionText(block.caption);
    default:
      return "";
  }
}

export function richBlocksToPlainText(blocks: readonly RichBlock[]): string {
  return blocks.map(richBlockToPlainText).filter(Boolean).join("\n\n");
}

type ReplySource = { text?: string; caption?: string; rich_message?: { blocks: RichBlock[] } };

/** Preserve a manually selected quote; otherwise prefer the whole original message. */
export function telegramReplyText(quote?: TextQuote, reply?: ReplySource): string | undefined {
  const selected = [quote?.text, quote?.rich_texts?.map(richTextToPlainText).join("\n")]
    .find((value): value is string => typeof value === "string" && !!value.trim());
  if (quote?.is_manual && selected) return selected;
  const full = [reply?.text, reply?.caption, reply?.rich_message && richBlocksToPlainText(reply.rich_message.blocks)]
    .find((value): value is string => typeof value === "string" && !!value.trim());
  return full ?? selected;
}

/** Add a bounded Telegram reply as Markdown context without storing a second message body. */
export function withTelegramQuote(messageText: string, replyText?: string): string {
  const text = messageText.trim();
  const quote = replyText?.replace(/\r\n?/g, "\n").trim();
  if (!quote) return text;

  const excerpt = truncateUtf16Text(quote, TELEGRAM_LONG_TEXT_LIMIT_UTF16, "…");
  const blockquote = excerpt.split("\n").map(line => `> ${line}`).join("\n");
  return `${blockquote}${text ? `\n\n${text}` : ""}`;
}
