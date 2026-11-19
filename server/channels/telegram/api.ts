import { Bot, GrammyError, InputFile } from "grammy";
import type { MessageAttachment } from "../../../shared/chat";
import type { AttachmentStore } from "../../attachments/store";

export type TelegramButton = { text: string; callbackData: string };
export type TelegramKeyboard = TelegramButton[][];
const markup = (buttons: TelegramKeyboard | undefined) => buttons === undefined ? {} :
  { reply_markup: { inline_keyboard: buttons.map(row => row.map(button => ({ text: button.text, callback_data: button.callbackData }))) } };

export interface TelegramTransport {
  send(chatId: string, text: string, rich: boolean, buttons?: TelegramKeyboard): Promise<string>;
  sendFile(chatId: string, attachment: MessageAttachment): Promise<void>;
  edit(chatId: string, messageId: string, text: string, rich: boolean, buttons?: TelegramKeyboard): Promise<void>;
  answerCallback(callbackId: string, text?: string, alert?: boolean): Promise<void>;
  remove(chatId: string, messageId: string): Promise<void>;
  typing(chatId: string): Promise<void>;
  /** Bytes of a photo or image document; the channel stores them and gives the model a path. */
  download(fileId: string): Promise<Uint8Array>;
}

/** Only descriptions of known formatting failures permit fallback, never transport ambiguity. */
export function isFormatError(error: unknown): boolean {
  return error instanceof GrammyError && error.error_code === 400 &&
    /parse|entit|rich.{0,40}(unsupported|not supported)|method.{0,40}not found|message.{0,20}too long/i.test(error.description);
}

export function telegramErrorCode(error: unknown): string {
  // SDK errors may include the token-bearing request URL or user content. Do not log them.
  return error instanceof GrammyError ? `API ${error.error_code}` : "network or local error";
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Telegram stopped.")); return; }
    const abort = () => { clearTimeout(timer); reject(new Error("Telegram stopped.")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function telegramRequest<T>(operation: () => Promise<T>, signal: AbortSignal,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = wait): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new Error("Telegram stopped.");
    try { return await operation(); }
    catch (error) {
      if (signal.aborted || attempt >= 2) throw error;
      if (error instanceof GrammyError && error.error_code !== 429 && error.error_code < 500) throw error;
      const delay = error instanceof GrammyError && error.error_code === 429
        ? Math.max(1, error.parameters.retry_after ?? 1) * 1000 : 500 * 2 ** attempt;
      // Do not block the delivery worker indefinitely on a long platform cooldown.
      if (delay > 15_000) throw error;
      await sleep(delay, signal);
    }
  }
}

export class TelegramApi implements TelegramTransport {
  readonly controller = new AbortController();
  // grammY's Node typings use the abort-controller polyfill; Bun's signal implements the same runtime protocol.
  get signal() { return this.controller.signal as unknown as NonNullable<Parameters<Bot["api"]["getWebhookInfo"]>[0]>; }
  constructor(private readonly bot: Bot, private readonly sentAttachments: AttachmentStore) {}

  async send(chatId: string, text: string, rich: boolean, buttons?: TelegramKeyboard): Promise<string> {
    const options = markup(buttons);
    const message = await telegramRequest<{ message_id: number }>(() => rich
      ? this.bot.api.sendRichMessage(chatId, { markdown: text }, options, this.signal)
      : this.bot.api.sendMessage(chatId, text, { ...options, link_preview_options: { is_disabled: true } }, this.signal), this.controller.signal);
    return String(message.message_id);
  }

  async sendFile(chatId: string, attachment: MessageAttachment): Promise<void> {
    const bytes = await this.sentAttachments.readSnapshot(attachment.id);
    if (!bytes) throw new Error("Attachment is unavailable.");
    // Non-idempotent: a timeout can mean Telegram already accepted the upload. Do not retry.
    await this.bot.api.sendDocument(chatId, new InputFile(bytes, attachment.name ?? "attachment"), {}, this.signal);
  }

  async edit(chatId: string, messageId: string, text: string, rich: boolean, buttons?: TelegramKeyboard): Promise<void> {
    try {
      await telegramRequest(() => this.bot.api.editMessageText(chatId, Number(messageId), rich ? { markdown: text } : text,
        { link_preview_options: { is_disabled: true }, ...markup(buttons) }, this.signal), this.controller.signal);
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 400 && /message is not modified/i.test(error.description)) return;
      throw error;
    }
  }

  async answerCallback(callbackId: string, text?: string, alert = false): Promise<void> {
    await telegramRequest(() => this.bot.api.answerCallbackQuery(callbackId, { text, show_alert: alert }, this.signal), this.controller.signal);
  }

  async remove(chatId: string, messageId: string): Promise<void> {
    await telegramRequest(() => this.bot.api.deleteMessage(chatId, Number(messageId), this.signal), this.controller.signal);
  }

  async typing(chatId: string): Promise<void> {
    await this.bot.api.sendChatAction(chatId, "typing", {}, this.signal);
  }

  async download(fileId: string): Promise<Uint8Array> {
    const file = await telegramRequest(() => this.bot.api.getFile(fileId, this.signal), this.controller.signal);
    if (!file.file_path) throw new Error("Telegram did not return a file path.");
    const response = await fetch(`https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`, { signal: this.controller.signal });
    if (!response.ok) throw new Error(`Telegram file download failed (${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
