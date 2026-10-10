import type { ChatRun } from "../../chat/run";
import { isFormatError, type TelegramTransport } from "./api";

/** Conservative 4,000 UTF-16 units also fit the plain-text fallback. Preserve code fences across chunks. */
export function splitReply(text: string, limit = 4000): string[] {
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
    for (const match of body.matchAll(/^\s*(`{3,}|~{3,})([^\n]*)/gm)) {
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
  constructor(private readonly api: TelegramTransport, private readonly chatId: string, private readonly replyTo?: string) {}

  async update(text: string, final = false): Promise<void> {
    const chunks = splitReply(text);
    for (const [index, chunk] of chunks.entries()) {
      const existing = this.messages[index];
      // Plain during streaming avoids parsing incomplete Markdown; rich rendering at completion.
      let rich = final && this.richSupported;
      if (existing?.text === chunk && existing.rich === rich) continue;
      const write = async () => {
        if (existing) await this.api.edit(this.chatId, existing.id, chunk, rich);
        else {
          const id = await this.api.send(this.chatId, chunk, rich, index === 0 ? this.replyTo : undefined);
          this.messages.push({ id, text: chunk, rich });
        }
      };
      try { await write(); }
      catch (error) {
        if (!rich || !isFormatError(error)) throw error;
        this.richSupported = false;
        rich = false;
        await write();
      }
      if (existing) { existing.text = chunk; existing.rich = rich; }
    }
    while (this.messages.length > chunks.length) {
      await this.api.remove(this.chatId, this.messages.at(-1)!.id);
      this.messages.pop();
    }
  }
}

/** Snapshot coalescing and all network waits happen outside the synchronous Run listener. */
export async function deliverRun(run: ChatRun, reply: TelegramReply, api: TelegramTransport, chatId: string,
  signal: AbortSignal, intervalMs = 1000): Promise<void> {
  let changed = true;
  let failure: unknown;
  const unsubscribe = run.subscribe(run.snapshot.lastEventId, () => { changed = true; });
  let lastTyping = 0;
  try {
    while (!signal.aborted) {
      const snapshot = run.snapshot;
      if (!run.active) {
        const suffix = snapshot.status === "cancelled" ? "\n\n[回复已停止]"
          : snapshot.status === "failed" ? "\n\n[回复失败，请在 RN 查看详情或重新发送]" : "";
        await reply.update((snapshot.text || (snapshot.status === "succeeded" ? "[没有文本回复]" : "")) + suffix, true);
        return;
      }
      if (Date.now() - lastTyping >= 4000) {
        // Typing failures do not interrupt answer delivery.
        await api.typing(chatId).catch(() => {});
        lastTyping = Date.now();
      }
      if (changed) {
        changed = false;
        try { await reply.update(snapshot.text); failure = undefined; }
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
