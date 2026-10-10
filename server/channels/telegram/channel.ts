import { RuntimeBusyError, type ConversationStore } from "../../chat/conversations";
import type { RunStatus } from "../../../shared/chat";
import type { ChatRuntime } from "../../runtime/types";
import { telegramErrorCode, type TelegramTransport } from "./api";
import { deliverRun, TelegramReply, TELEGRAM_STREAM_INTERVAL_MS } from "./output";
import { TelegramMenus, TelegramMenuError, selectionText, type TelegramCallback } from "./menus";

export type TelegramMessage = {
  chatId: string; messageId: string; actorId: string; chatType: string; text?: string;
  topic?: boolean; business?: boolean;
};

export const TELEGRAM_COMMANDS = [
  { command: "start", description: "Get started" }, { command: "help", description: "Show commands" },
  { command: "status", description: "View status" }, { command: "stop", description: "Stop the current reply" },
  { command: "recent", description: "View recent messages" }, { command: "skills", description: "Browse skills" },
  { command: "plugins", description: "View plugins" },
  { command: "models", description: "Choose a model" }, { command: "thinking", description: "Set thinking level" },
  { command: "compact", description: "Compact context" },
];
const HELP = "Send a text message to get started. Your conversation is shared with the Piko app.\n\n" +
  TELEGRAM_COMMANDS.map(item => `/${item.command} — ${item.description}`).join("\n") +
  "\n\nUse /recent to see replies from the app. Model changes and maintenance are available when Piko is idle.";
const RUN_LABELS: Record<RunStatus, string> = {
  queued: "Queued", running: "Replying", cancelling: "Stopping", succeeded: "Done", failed: "Failed", cancelled: "Stopped",
};

export class TelegramChannel {
  private accepting = true;
  private readonly controller = new AbortController();
  private readonly tasks = new Set<Promise<void>>();
  private readonly deliveries = new Set<string>();
  private readonly menus: TelegramMenus;
  constructor(private readonly identity: { botId: string; username: string; userId: string },
    private readonly conversations: ConversationStore, private readonly runtime: ChatRuntime,
    private readonly api: TelegramTransport, private readonly intervalMs = TELEGRAM_STREAM_INTERVAL_MS) {
    this.menus = new TelegramMenus(conversations, runtime, api);
  }

  handleCallback(callback: TelegramCallback): void {
    if (!this.accepting || callback.actorId !== this.identity.userId || callback.chatType !== "private" ||
      callback.topic || callback.business) return;
    this.track(this.menus.handle(callback).catch(async error => {
      if (!(error instanceof TelegramMenuError)) throw error;
      await this.api.answerCallback(callback.callbackId, error.message, true);
    }));
  }

  async handle(message: TelegramMessage): Promise<void> {
    if (!this.accepting || message.actorId !== this.identity.userId || message.chatType !== "private" ||
      message.topic || message.business) return;
    if (message.text === undefined) { this.feedback(message, "Please send a text message."); return; }
    const text = message.text.trim();
    if (text.startsWith("/")) {
      const match = /^\/([a-zA-Z_]+)(?:@([\w]+))?(?:\s.*)?$/.exec(text);
      if (!match || match[2] && match[2].toLowerCase() !== this.identity.username.toLowerCase()) {
        this.feedback(message, "Unknown command. Use /help to see what's available."); return;
      }
      // Stop admission/control is awaited; network presentation is always independent.
      if (match[1].toLowerCase() === "stop") {
        try {
          const stopped = await this.conversations.stopTelegram({ botId: this.identity.botId, chatId: message.chatId,
            messageId: message.messageId, actorId: message.actorId }, text);
          this.feedback(message, stopped ? "Stop requested." : "No reply to stop.");
        } catch { this.feedback(message, "Couldn't stop the reply. Try /stop again."); }
      } else this.track(this.command(message, match[1].toLowerCase()));
      return;
    }
    const result = await this.conversations.startTelegram({ botId: this.identity.botId, chatId: message.chatId,
      messageId: message.messageId, actorId: message.actorId }, message.text);
    if (result.disposition === "busy") this.feedback(message, "Piko is busy. Please wait, then send your message again.");
    else if (result.disposition === "invalid") this.feedback(message, "Send a message with 1–12,000 characters.");
    else if (result.run && !result.duplicate && !this.deliveries.has(result.run.snapshot.id)) {
      const id = result.run.snapshot.id;
      this.deliveries.add(id);
      this.track(deliverRun(result.run, new TelegramReply(this.api, message.chatId), this.api,
        message.chatId, this.controller.signal, this.intervalMs).finally(() => this.deliveries.delete(id)));
    } else if (result.duplicate) {
      this.feedback(message, "Already processed. Use /recent to view the reply.");
    }
  }

  private async command(message: TelegramMessage, command: string): Promise<void> {
    try { await this.executeCommand(message, command); }
    catch (error) {
      if (!(error instanceof RuntimeBusyError)) console.warn(`Telegram command failed (${telegramErrorCode(error)}).`);
      await new TelegramReply(this.api, message.chatId, "plain").update(error instanceof RuntimeBusyError
        ? "Piko is busy. Try again when it's ready."
        : "Couldn't complete that action. Check your configuration and try again.", true);
    }
  }

  private async executeCommand(message: TelegramMessage, command: string): Promise<void> {
    let text: string;
    const sessionId = this.conversations.main.sessionId;
    if (command === "start" || command === "help") text = HELP;
    else if (command === "status") {
      const run = await this.conversations.run(sessionId);
      text = `Status: ${run?.active ? RUN_LABELS[run.snapshot.status] : this.conversations.isStreaming(sessionId) ? "Busy" : "Ready"}` +
        (run && !run.active ? `\nLast reply: ${run.snapshot.errorCode === "interrupted" ? "Interrupted. Please resend your message." : RUN_LABELS[run.snapshot.status]}` : "");
      if (this.runtime.describe) {
        try {
          const description = await this.runtime.describe(this.conversations.context());
          text += `\n${selectionText(description)}\nSkills: ${description.skills.length}\nPlugins: ${description.plugins.length}`;
        } catch { text += "\nModel details unavailable."; }
      }
    } else if ((command === "models" || command === "thinking") && this.runtime.describe && this.runtime.configure) {
      await this.menus.open(message, command); return;
    } else if (command === "compact" && this.runtime.compact) {
      await this.conversations.changeRuntime(async () => {
        this.feedback(message, "Compacting context…");
        await this.runtime.compact!(this.conversations.context());
      });
      text = "Context compacted. Your chat history is preserved.";
      if (this.runtime.describe) text += `\n${selectionText(await this.runtime.describe(this.conversations.context()))}`;
    } else if (command === "recent") {
      const history = await this.conversations.history(sessionId);
      text = history.slice(-10).map(item => `${item.role === "user" ? "You" : "Piko"}:\n${item.content}`).join("\n\n") || "No messages yet.";
      const run = await this.conversations.run(sessionId);
      if (run?.active && run.snapshot.text) text += `\n\nPiko (replying):\n${run.snapshot.text}`;
    } else if ((command === "skills" || command === "plugins") && this.runtime.describe) {
      const description = await this.runtime.describe(this.conversations.context());
      text = command === "skills" ? description.skills.map(item => `${item.name} — ${item.description}`).join("\n") || "No skills available."
        : description.plugins.map(item => `${item.name}${item.tools.length ? ` — ${item.tools.join(", ")}` : ""}`).join("\n") || "No plugins loaded.";
    } else text = "Unknown command. Use /help to see what's available.";
    await new TelegramReply(this.api, message.chatId, "plain").update(text, true);
  }

  private feedback(message: TelegramMessage, text: string): void {
    this.track(new TelegramReply(this.api, message.chatId, "plain").update(text, true));
  }

  private track(promise: Promise<void>): void {
    const task = promise.catch(error => console.warn(`Telegram delivery/command failed (${telegramErrorCode(error)}); saved history remains available in RN.`));
    this.tasks.add(task);
    void task.then(() => this.tasks.delete(task));
  }

  stopAccepting(): void { this.accepting = false; }

  async drain(timeoutMs = 3000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.all([...this.tasks]), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
    finally { clearTimeout(timer); this.controller.abort(); }
  }
}
