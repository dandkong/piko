import type { ChatRun } from "../../chat/run";
import { isFormatError, type TelegramTransport } from "./api";
import remend from "remend";
import type { MessageEvent } from "../../../shared/messages";

export const TELEGRAM_RICH_LIMIT = 30_000;
export const TELEGRAM_PLAIN_LIMIT = 4000;
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
    const capacity = limit - prefix.length - 128;
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
      // Re-split the entire snapshot: a rich chunk can exceed the plain-text limit.
      await this.sync(text, final, false);
    }
  }

  private async sync(text: string, final: boolean, rich: boolean): Promise<void> {
    const chunks = text.trim() ? splitReply(text, rich ? TELEGRAM_RICH_LIMIT : TELEGRAM_PLAIN_LIMIT, rich) : [];
    for (const [index, chunk] of chunks.entries()) {
      const existing = this.messages[index];
      // Match pi-pilot's Rich Markdown stream repair; never modify stored model text.
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
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly api: TelegramTransport, private readonly chatId: string, private readonly first?: TelegramReply) {}

  update(event: MessageEvent): Promise<void> {
    const task = this.pending.catch(() => {}).then(async () => {
      if (!event.message.content.trim() && !this.replies.has(event.message.id)
        && (!event.previousId || !this.replies.has(event.previousId))) return;
      const existing = this.replies.get(event.message.id) ?? (event.previousId ? this.replies.get(event.previousId) : undefined);
      if (existing?.final && !event.final) return;
      const record = existing ?? { reply: (!this.replies.size ? this.first : undefined) ?? new TelegramReply(this.api, this.chatId), final: false };
      // Keep the live alias until delivery drains: a slower observer may still hold an older partial.
      this.replies.set(event.message.id, record);
      if (event.previousId) this.replies.set(event.previousId, record);
      await record.reply.update(event.message.content, event.final);
      record.final = event.final;
    });
    this.pending = task;
    return task;
  }
}

/** Snapshot coalescing and all network waits happen outside the synchronous input listener. */
export async function deliverRun(run: ChatRun, reply: TelegramReply, api: TelegramTransport, chatId: string,
  signal: AbortSignal, intervalMs = TELEGRAM_STREAM_INTERVAL_MS,
  output = new TelegramMessageOutput(api, chatId, reply)): Promise<void> {
  let changed = true;
  const sync = async () => {
    for (const event of run.outputs) await output.update(event);
  };
  let failure: unknown;
  const unsubscribe = run.subscribe(run.snapshot.lastEventId, () => { changed = true; });
  let lastTyping = 0;
  try {
    while (!signal.aborted) {
      const snapshot = run.snapshot;
      if (!run.active) {
        await sync();
        const suffix = snapshot.status === "cancelled" ? "\n\nReply stopped."
          : snapshot.status === "failed" ? "\n\nCouldn't finish this reply. Please try again." : "";
        const partial = run.outputs.find(event => !event.final);
        if (partial) await output.update({ ...partial, final: true,
          message: { ...partial.message, content: partial.message.content + suffix } });
        else if (suffix || !run.outputs.some(event => event.message.content.trim())) await new TelegramReply(api, chatId, "plain")
          .update(suffix.trim() || "No text response.", true);
        return;
      }
      if (Date.now() - lastTyping >= 4000) {
        // Typing failures do not interrupt answer delivery.
        await api.typing(chatId).catch(() => {});
        lastTyping = Date.now();
      }
      if (changed) {
        changed = false;
        // Typing/network waits may have allowed another update; read after clearing the dirty flag.
        try { await sync(); failure = undefined; }
        catch (error) { failure = error; }
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) { resolve(); return; }
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, intervalMs);
        signal.addEventListener("abort", done, { once: true });
      });
    }
    if (failure) throw failure;
  } finally { unsubscribe(); }
}
