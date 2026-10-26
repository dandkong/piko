import type { ConversationResponse, MessageEvent } from "../../../shared/chat";
import type { SessionEvent } from "../../runtime/types";
import { singleLine, SUMMARY_TEXT_LIMIT } from "../../runtime/text";
import { toolIcon } from "../../runtime/tool-activity";
import { telegramErrorCode, type TelegramTransport } from "./api";
import { TelegramMessageOutput, TelegramReply } from "./output";
import { formatCompaction } from "./command-format";

type OutputEvent = SessionEvent | { type: "snapshot"; conversation: ConversationResponse };

/** One presentation queue for text, tools, boundaries, manual notices and run cleanup. */
export class TelegramConversationOutput {
  private pending: Promise<void> = Promise.resolve();
  private text?: MessageEvent;
  private textTimer?: ReturnType<typeof setTimeout>;
  private typingTimer?: ReturnType<typeof setInterval>;
  private readonly messages: TelegramMessageOutput;
  private readonly known = new Set<string>();
  private readonly tools: TelegramReply[] = [];
  private toolReply?: TelegramReply;
  private readonly toolLines = new Map<string, string>();
  private closed = false;
  private stopSuppression?: object;

  constructor(private readonly api: TelegramTransport, private readonly chatId: string,
    private readonly intervalMs: number, private readonly canNotifyCompaction: () => boolean) {
    this.messages = new TelegramMessageOutput(api, chatId);
  }

  accept(event: OutputEvent): void {
    if (!this.closed) this.enqueue(() => this.handle(event));
  }

  /** Background admission hints only sustain typing; the main conversation owns all actual output. */
  wake(): void {
    if (!this.closed) this.startTyping();
  }

  /** The command sends its own feedback; suppress only the run at this ordered point. */
  suppressStopNotice(): () => void {
    const token = {};
    this.enqueue(async () => { this.stopSuppression = token; });
    return () => this.enqueue(async () => {
      if (this.stopSuppression === token) this.stopSuppression = undefined;
    });
  }

  private enqueue(operation: () => Promise<void>) {
    this.pending = this.pending.then(operation).catch(error => {
      console.warn(`Telegram conversation output failed (${telegramErrorCode(error)}).`);
    });
  }

  private async handle(event: OutputEvent) {
    switch (event.type) {
      case "snapshot":
        for (const message of event.conversation.messages)
          if (message.role === "assistant" && !message.id.startsWith("live-")) this.remember(message.id);
        if (event.conversation.busy) {
          this.startTyping();
          const live = event.conversation.messages.find(message => message.role === "assistant" && message.id.startsWith("live-"));
          if (live) await this.handle({ type: "message", message: live, final: false });
        }
        return;
      case "message":
        if (event.message.role !== "assistant" || this.known.has(event.message.id)) return;
        if (!event.message.content.trim() && !event.previousId) return;
        this.breakTools();
        if (this.text && this.text.message.id !== event.message.id && this.text.message.id !== event.previousId)
          await this.flushText();
        this.text = event;
        if (event.final) await this.flushText();
        else if (!this.textTimer) this.textTimer = setTimeout(() => {
          this.textTimer = undefined;
          this.enqueue(() => this.flushText());
        }, this.intervalMs);
        return;
      case "tool":
        if (event.activity.status !== "running") return;
        // Buffered text is sent before the following tool, not on an independent timer/queue.
        await this.flushText();
        this.startTyping();
        this.toolLines.set(event.activity.callId, singleLine(
          `${toolIcon(event.activity.name)} ${event.activity.name}${event.activity.summary ? `: ${event.activity.summary}` : ""}`,
          SUMMARY_TEXT_LIMIT,
        )!);
        if (!this.toolReply) {
          this.toolReply = new TelegramReply(this.api, this.chatId, "plain");
          this.tools.push(this.toolReply);
        }
        await this.toolReply.update([...this.toolLines.values()].join("\n"), true);
        return;
      case "input-applied":
      case "run-start":
        await this.flushText();
        this.breakTools();
        if (event.type === "run-start") {
          this.stopSuppression = undefined;
          this.startTyping();
        }
        return;
      case "run-end": {
        await this.flushText();
        await this.finishTools();
        const suppressed = !!this.stopSuppression;
        this.stopSuppression = undefined;
        const failed = event.submissions.findLast(item => item.status === "unanswered");
        if (failed) {
          if (failed.error === "aborted") {
            if (!suppressed) await this.api.send(this.chatId, "Stopped.", false);
          } else await this.api.send(this.chatId, "Reply failed. Check the Piko app or /recent for saved messages.", false);
        }
        return;
      }
      case "compaction":
        if (event.phase === "start") { await this.flushText(); this.breakTools(); }
        if (event.reason === "manual" && this.canNotifyCompaction()) await this.api.send(this.chatId, formatCompaction(event), false);
        return;
      case "deleted": this.stopTyping(); return;
      case "activity":
        // An authoritative native snapshot can recover past a missed run-end boundary.
        if (event.activity.kind === "idle") {
          await this.flushText();
          await this.finishTools();
        }
        return;
      case "invalidated":
      case "error": return;
      default: { const exhaustive: never = event; return exhaustive; }
    }
  }

  private remember(id: string) {
    this.known.add(id);
    if (this.known.size > 512) this.known.delete(this.known.values().next().value!);
  }

  private async flushText() {
    clearTimeout(this.textTimer);
    this.textTimer = undefined;
    const event = this.text;
    this.text = undefined;
    if (!event) return;
    await this.messages.update(event);
    if (event.final) this.remember(event.message.id);
  }

  private async finishTools() {
    this.breakTools();
    this.stopTyping();
    for (const reply of this.tools.splice(0)) await reply.deleteMessages();
  }

  private breakTools() {
    this.toolLines.clear();
    this.toolReply = undefined;
  }

  private startTyping() {
    if (this.typingTimer || this.closed) return;
    void this.api.typing(this.chatId).catch(() => {});
    this.typingTimer = setInterval(() => { void this.api.typing(this.chatId).catch(() => {}); }, 4000);
  }
  private stopTyping() {
    clearInterval(this.typingTimer);
    this.typingTimer = undefined;
  }

  async close(timeoutMs: number) {
    this.closed = true;
    clearTimeout(this.textTimer);
    this.stopTyping();
    this.enqueue(() => this.flushText());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.pending, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
    finally { clearTimeout(timer); this.stopTyping(); }
  }
}
