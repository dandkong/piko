import { isFormatError, type TelegramTransport } from "./api";
import remend from "remend";
import type { MessageEvent } from "../../../shared/chat";
import { TELEGRAM_MENU_TEXT_LIMIT } from "./menu-policy";

export const TELEGRAM_RICH_LIMIT = 30_000;
export const TELEGRAM_PLAIN_LIMIT = TELEGRAM_MENU_TEXT_LIMIT;
export const TELEGRAM_STREAM_INTERVAL_MS = 800;
export type TelegramRenderMode = "markdown" | "plain";

/** Bound UTF-16 chunks without splitting surrogate pairs; repair fences only for Markdown. */
export function splitReply(text: string, limit = TELEGRAM_PLAIN_LIMIT, preserveFences = true): string[] {
  if (limit < 256) throw new Error("Reply chunk limit is too small.");
  const result: string[] = [];
  let remaining = text;
  let fence = "";
  while (remaining.length) {
    const prefix = fence ? `${fence}\n` : "";
    const capacity = limit - prefix.length - (preserveFences ? 128 : 0);
    let end = Math.min(capacity, remaining.length);
    if (end < remaining.length) {
      const newline = remaining.lastIndexOf("\n", end - 1);
      if (newline > end / 2) end = newline + 1;
      const unit = remaining.charCodeAt(end - 1);
      if (unit >= 0xd800 && unit <= 0xdbff) end--;
    }
    const body = remaining.slice(0, end);
    if (preserveFences) for (const match of body.matchAll(/^\s*(`{3,}|~{3,})([^\n]*)/gm)) {
      if (!fence) fence = match[0].trim().slice(0, 80);
      else if (match[1][0] === fence[0] && match[1].length >= /^(`+|~+)/.exec(fence)![0].length && !match[2].trim()) fence = "";
    }
    const suffix = fence ? `\n${/^(`+|~+)/.exec(fence)![0]}` : "";
    result.push(prefix + body + suffix);
    remaining = remaining.slice(end);
  }
  return result;
}

export class TelegramReply {
  private readonly messages: { id: string; text: string; rich: boolean }[] = [];
  private richSupported = true;
  constructor(private readonly api: TelegramTransport, private readonly chatId: string,
    private readonly render: TelegramRenderMode = "markdown") {}

  async update(text: string, final = false): Promise<void> {
    const rich = this.render === "markdown" && this.richSupported;
    try { await this.sync(text, final, rich); }
    catch (error) {
      if (!rich || !isFormatError(error)) throw error;
      this.richSupported = false;
      await this.sync(text, final, false);
    }
  }

  async deleteMessages(): Promise<void> {
    for (const { id } of this.messages.splice(0).reverse()) {
      try { await this.api.remove(this.chatId, id); }
      catch { /* the message may already be gone or too old to delete */ }
    }
  }

  private async sync(text: string, final: boolean, rich: boolean): Promise<void> {
    const chunks = text.trim() ? splitReply(text, rich ? TELEGRAM_RICH_LIMIT : TELEGRAM_PLAIN_LIMIT, rich) : [];
    for (const [index, chunk] of chunks.entries()) {
      const existing = this.messages[index];
      const rendered = rich && !final ? remend(chunk, { linkMode: "text-only", inlineKatex: false }) : chunk;
      if (existing?.text === rendered && existing.rich === rich) continue;
      if (existing) {
        await this.api.edit(this.chatId, existing.id, rendered, rich);
        existing.text = rendered; existing.rich = rich;
      } else {
        const id = await this.api.send(this.chatId, rendered, rich);
        this.messages.push({ id, text: rendered, rich });
      }
    }
    while (this.messages.length > chunks.length) {
      await this.api.remove(this.chatId, this.messages.at(-1)!.id);
      this.messages.pop();
    }
  }
}

/** Delivery identities belong to assistant messages, independently of input receipts. */
export class TelegramMessageOutput {
  private replies = new Map<string, { reply: TelegramReply; final: boolean }>();
  constructor(private readonly api: TelegramTransport, private readonly chatId: string) {}

  /** Called only by the conversation's serial presentation queue. */
  async update(event: MessageEvent): Promise<void> {
    if (!event.message.content.trim() && !this.replies.has(event.message.id)
      && (!event.previousId || !this.replies.has(event.previousId))) return;
    const existing = this.replies.get(event.message.id) ?? (event.previousId ? this.replies.get(event.previousId) : undefined);
    if (existing?.final && !event.final) return;
    const record = existing ?? { reply: new TelegramReply(this.api, this.chatId), final: false };
    this.replies.set(event.message.id, record);
    if (event.previousId) this.replies.set(event.previousId, record);
    await record.reply.update(event.message.content, event.final);
    record.final = event.final;
    // Preserve recent live/final aliases without retaining the entire long-lived root transcript.
    while (this.replies.size > 256) this.replies.delete(this.replies.keys().next().value!);
  }
}
