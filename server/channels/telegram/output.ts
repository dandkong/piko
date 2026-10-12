import type { ConversationStore } from "../../chat/conversations";
import { isFormatError, type TelegramTransport } from "./api";
import remend from "remend";
import { applyMessageEvent, type MessageEvent } from "../../../shared/messages";

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

/** Conversation output is independent of the submission that enabled delivery. */
export async function deliverConversation(store: ConversationStore, api: TelegramTransport, chatId: string,
  signal: AbortSignal, known: Set<string>, intervalMs = TELEGRAM_STREAM_INTERVAL_MS, awaitStart = false, finished: () => Promise<boolean> = async () => true): Promise<void> {
  const output = new TelegramMessageOutput(api, chatId);
  let conversation = await store.snapshot(); let dirty = true;
  let started = !awaitStart || conversation.busy || conversation.messages.some(message => message.role === "assistant" && !known.has(message.id));
  const startDeadline = Date.now() + 30000;
  const unsubscribe = await store.observe(event => {
    if (event.type === "snapshot") { conversation = event.conversation; dirty = true; if (conversation.busy) started = true; }
    else if (event.type === "message") {
      conversation = { ...conversation, messages: applyMessageEvent(conversation.messages, event),
        previousIds: event.previousId ? { ...conversation.previousIds, [event.message.id]: event.previousId } : conversation.previousIds };
      dirty = true; started = true;
    }
  });
  try {
    let typing = 0;
    while (!signal.aborted) {
      const snapshot = conversation;
      if (dirty) {
        dirty = false;
        for (const message of snapshot.messages) {
          if (message.role !== "assistant" || known.has(message.id)) continue;
          await output.update({ type: "message", message, final: !message.id.startsWith("live-"),
            ...(snapshot.previousIds?.[message.id] && { previousId: snapshot.previousIds[message.id] }) });
        }
      }
      if ((!snapshot.busy && started || Date.now() > startDeadline && !started) && snapshot === conversation && !dirty) {
        const drained = await finished();
        if (snapshot !== conversation || dirty) continue;
        if (!drained && Date.now() <= startDeadline) {
          await new Promise(resolve => setTimeout(resolve, intervalMs)); continue;
        }
        // The native receipt can settle before the coalesced feed publishes its final message.
        const current = await store.snapshot();
        const sameMessages = current.messages.length === snapshot.messages.length && current.messages.every((message, index) =>
          message.id === snapshot.messages[index].id && message.content === snapshot.messages[index].content);
        if (current.busy || !sameMessages || current.latest?.status !== snapshot.latest?.status) { conversation = current; dirty = true; continue; }
        if (snapshot !== conversation || dirty) continue;
        if (snapshot.latest?.status === "unanswered") await api.send(chatId,
          snapshot.latest.error === "aborted" ? "Reply stopped." : "Reply failed. Check the Piko app or /recent for saved messages.", false);
        return;
      }
      if (Date.now() - typing >= 4000) { typing = Date.now(); await api.typing(chatId).catch(() => {}); }
      await new Promise<void>(resolve => {
        if (signal.aborted) { resolve(); return; }
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, intervalMs); signal.addEventListener("abort", done, { once: true });
      });
    }
  } finally { unsubscribe(); }
}
