import type { ConversationStore } from "../../chat/conversations";
import { isFormatError, type TelegramTransport } from "./api";
import remend from "remend";
import { applyMessageEvent, type MessageEvent } from "../../../shared/messages";
import { CHAT_PAGE_SIZE, type Message } from "../../../shared/chat";

export const TELEGRAM_RICH_LIMIT = 30_000;
export const TELEGRAM_PLAIN_LIMIT = 4096;
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
      // Re-split the entire snapshot: a rich chunk can exceed the plain-text limit.
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
  signal: AbortSignal, known: Set<string>, intervalMs = TELEGRAM_STREAM_INTERVAL_MS, awaitStart = false,
  finished: () => Promise<boolean> = async () => true, shouldNotifyStopped: (submissionId: string) => boolean = () => true): Promise<void> {
  const output = new TelegramMessageOutput(api, chatId);
  let conversation = await store.snapshot({ limit: CHAT_PAGE_SIZE }); let dirty = true;
  let started = !awaitStart || conversation.busy || conversation.messages.some(message => message.role === "assistant" && !known.has(message.id));
  let firstPartialAt: number | undefined;
  let firstOutputSent = false;
  let delayedFirstOutput = false;
  let wakeCurrent: (() => void) | undefined;
  const noteFirstPartial = (messages: readonly Message[]) => {
    if (firstOutputSent || firstPartialAt !== undefined) return;
    if (messages.some(message => message.role === "assistant" && message.id.startsWith("live-") && !known.has(message.id) && message.content.trim()))
      firstPartialAt = Date.now();
  };
  noteFirstPartial(conversation.messages);
  const startDeadline = Date.now() + 30000;
  const unsubscribe = await store.observe(event => {
    if (event.type === "snapshot") {
      const hadPartial = firstPartialAt !== undefined;
      conversation = event.conversation; noteFirstPartial(conversation.messages); dirty = true;
      if (conversation.busy) started = true;
      if (!conversation.busy || (!hadPartial && firstPartialAt !== undefined && !firstOutputSent)) wakeCurrent?.();
    } else if (event.type === "message") {
      const hadPartial = firstPartialAt !== undefined;
      noteFirstPartial([event.message]);
      conversation = { ...conversation, messages: applyMessageEvent(conversation.messages, event),
        previousIds: event.previousId ? { ...conversation.previousIds, [event.message.id]: event.previousId } : conversation.previousIds };
      dirty = true; started = true;
      if (event.final || (!hadPartial && firstPartialAt !== undefined && !firstOutputSent)) wakeCurrent?.();
    }
  });
  try {
    let typing = 0;
    while (!signal.aborted) {
      if (delayedFirstOutput && firstPartialAt !== undefined && Date.now() - firstPartialAt >= intervalMs) {
        delayedFirstOutput = false;
        dirty = true;
      }
      const snapshot = conversation;
      if (dirty) {
        const pendingMessages = snapshot.messages.filter(message => message.role === "assistant" && !known.has(message.id) && message.content.trim());
        const hasLiveText = pendingMessages.some(message => message.id.startsWith("live-"));
        const hasFinalText = pendingMessages.some(message => !message.id.startsWith("live-"));
        if (!firstOutputSent && hasLiveText && !hasFinalText && firstPartialAt !== undefined && Date.now() - firstPartialAt < intervalMs) {
          dirty = false;
          delayedFirstOutput = true;
        } else {
          dirty = false;
          for (const message of snapshot.messages) {
            if (message.role !== "assistant" || known.has(message.id)) continue;
            await output.update({ type: "message", message, final: !message.id.startsWith("live-"),
              ...(snapshot.previousIds?.[message.id] && { previousId: snapshot.previousIds[message.id] }) });
            if (message.content.trim()) firstOutputSent = true;
          }
          delayedFirstOutput = false;
        }
      }
      if ((!snapshot.busy && started || Date.now() > startDeadline && !started) && snapshot === conversation && !dirty) {
        const drained = await finished();
        if (snapshot !== conversation || dirty) continue;
        if (!drained && Date.now() <= startDeadline) {
          await new Promise(resolve => setTimeout(resolve, intervalMs)); continue;
        }
        // The native receipt can settle before the coalesced feed publishes its final message.
        const current = await store.snapshot({ limit: CHAT_PAGE_SIZE });
        const sameMessages = current.messages.length === snapshot.messages.length && current.messages.every((message, index) =>
          message.id === snapshot.messages[index].id && message.content === snapshot.messages[index].content);
        if (current.busy || !sameMessages || current.latest?.status !== snapshot.latest?.status) { conversation = current; dirty = true; continue; }
        if (snapshot !== conversation || dirty) continue;
        if (snapshot.latest?.status === "unanswered") {
          if (snapshot.latest.error === "aborted") {
            if (shouldNotifyStopped(snapshot.latest.id)) await api.send(chatId, "Stopped.", false);
          } else await api.send(chatId, "Reply failed. Check the Piko app or /recent for saved messages.", false);
        }
        return;
      }
      if (Date.now() - typing >= 4000) { typing = Date.now(); await api.typing(chatId).catch(() => {}); }
      await new Promise<void>(resolve => {
        if (signal.aborted) { resolve(); return; }
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer); signal.removeEventListener("abort", done);
          if (wakeCurrent === done) wakeCurrent = undefined;
          resolve();
        };
        const delay = delayedFirstOutput && firstPartialAt !== undefined
          ? Math.max(0, Math.min(intervalMs, firstPartialAt + intervalMs - Date.now()))
          : intervalMs;
        const timer = setTimeout(done, delay);
        wakeCurrent = done;
        signal.addEventListener("abort", done, { once: true });
      });
    }
  } finally { unsubscribe(); }
}
