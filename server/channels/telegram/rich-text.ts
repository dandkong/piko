import type { InputRichBlock, InputRichMessage, RichTextButton } from "grammy/types";
import { truncateUtf16Text } from "../../runtime/text";
import { isFormatError, isRichMenuError, type TelegramKeyboard, type TelegramTransport } from "./api";
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

export type RichMenuView = { text: string; buttons?: TelegramKeyboard; rich: InputRichMessage };

/** Telegram embeds buttons in the rich text; user-provided text stays a plain RichText string. */
export function menuInlineButton(text: string, callbackData: string): RichTextButton {
  if (new TextEncoder().encode(callbackData).byteLength > 64) throw new Error("Menu callback is too long.");
  return { type: "button", button: { text, callback_data: callbackData, style: "primary" } };
}
export function menuNavigation(buttons: TelegramKeyboard[number]): InputRichBlock {
  return { type: "buttons", align: "right", buttons: buttons.map(button => {
    if (new TextEncoder().encode(button.callbackData).byteLength > 64) throw new Error("Menu callback is too long.");
    return { text: button.text, callback_data: button.callbackData };
  }) };
}
export async function sendRichMenu(api: TelegramTransport, chatId: string, view: RichMenuView, fallbackRich = false): Promise<string> {
  try { return await api.sendRich(chatId, view.rich); }
  catch (error) {
    if (!isRichMenuError(error)) throw error;
    return fallbackRich ? sendTelegramRich(api, chatId, view.text, view.buttons) : api.send(chatId, view.text, false, view.buttons);
  }
}
export async function editRichMenu(api: TelegramTransport, chatId: string, messageId: string, view: RichMenuView, fallbackRich = false): Promise<void> {
  try { await api.editRich(chatId, messageId, view.rich); }
  catch (error) {
    if (!isRichMenuError(error)) throw error;
    if (fallbackRich) await editTelegramRich(api, chatId, messageId, view.text, view.buttons);
    else await api.edit(chatId, messageId, view.text, false, view.buttons);
  }
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
