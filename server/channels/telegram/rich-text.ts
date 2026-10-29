import { truncateUtf16Text } from "../../runtime/text";
import { isFormatError, type TelegramKeyboard, type TelegramTransport } from "./api";
import { TELEGRAM_MENU_TEXT_LIMIT } from "./menu-policy";

/** Escape untrusted title/description text before embedding it in Telegram Markdown. */
export function escapeTelegramMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+.!|>~-]/g, "\\$&");
}

/** Keep every visible character while staying below Telegram's per-message UTF-16 limit. */
export function splitTelegramRichText(value: string, limit = TELEGRAM_MENU_TEXT_LIMIT - 128): string[] {
  const chunks: string[] = [];
  let rest = value;
  while (rest.length > limit) {
    const bounded = truncateUtf16Text(rest, limit, "");
    const paragraph = bounded.lastIndexOf("\n\n");
    const line = bounded.lastIndexOf("\n");
    const boundary = paragraph >= limit * 0.5 ? paragraph : line >= limit * 0.5 ? line : bounded.length;
    const chunk = bounded.slice(0, boundary);
    if (!chunk) throw new Error("Could not split Telegram rich text.");
    chunks.push(chunk);
    rest = rest.slice(chunk.length);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function sendTelegramRich(api: TelegramTransport, chatId: string, text: string, buttons?: TelegramKeyboard): Promise<string> {
  try { return await api.send(chatId, text, true, buttons); }
  catch (error) {
    if (!isFormatError(error)) throw error;
    return api.send(chatId, text, false, buttons);
  }
}

export async function editTelegramRich(api: TelegramTransport, chatId: string, messageId: string, text: string, buttons?: TelegramKeyboard): Promise<void> {
  try { await api.edit(chatId, messageId, text, true, buttons); }
  catch (error) {
    if (!isFormatError(error)) throw error;
    await api.edit(chatId, messageId, text, false, buttons);
  }
}
