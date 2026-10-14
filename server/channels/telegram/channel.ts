import type { ConversationStore } from "../../chat/conversations";
import { RuntimeBusyError, type ChatRuntime } from "../../runtime/types";
import { normalizeMessage } from "../../chat/input";
import { telegramErrorCode, type TelegramTransport } from "./api";
import { deliverConversation, TelegramReply, TELEGRAM_STREAM_INTERVAL_MS } from "./output";
import { TelegramMenus, TelegramMenuError, selectionText, type TelegramCallback } from "./menus";

export type TelegramMessage = {
  chatId: string; messageId: string; actorId: string; chatType: string; text?: string;
  topic?: boolean; business?: boolean;
};

export const TELEGRAM_COMMANDS = [
  { command: "start", description: "Get started" }, { command: "help", description: "Show commands" },
  { command: "status", description: "View status" }, { command: "stop", description: "Stop the current reply" },
  { command: "recent", description: "View recent messages" }, { command: "skills", description: "Browse skills" },
  { command: "models", description: "Choose a model" }, { command: "thinking", description: "Set thinking level" },
  { command: "compact", description: "Compact context" },
];
const HELP = "Send a text message to get started. Your conversation is shared with the Piko app.\n\n" +
  TELEGRAM_COMMANDS.map(item => `/${item.command} — ${item.description}`).join("\n") +
  "\n\nUse /recent to see replies from the app. Model changes and maintenance are available when Piko is idle.";
export class TelegramChannel {
  private accepting = true;
  private readonly controller = new AbortController();
  private readonly tasks = new Set<Promise<void>>();
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly menus: TelegramMenus;
  private pendingReports = new Map<string, Set<string>>();
  private unsubscribeReplies?: () => void;
  constructor(private readonly identity: { botId: string; username: string; userId: string },
    private readonly conversations: ConversationStore, private readonly runtime: ChatRuntime,
    private readonly api: TelegramTransport, private readonly intervalMs = TELEGRAM_STREAM_INTERVAL_MS) {
    this.menus = new TelegramMenus(conversations, runtime, api);
    this.track(conversations.subscribeBackgroundReplies(async reply => {
      if (!this.accepting || reply.source.channel !== "telegram" || reply.source.botId !== this.identity.botId || reply.source.chatId !== this.identity.userId) return;
      const pending = this.pendingReports.get(reply.source.chatId) ?? new Set<string>(); pending.add(reply.requestId); this.pendingReports.set(reply.source.chatId, pending);
      this.startDelivery(reply.source.chatId, new Set(reply.knownMessageIds));
    }).then(unsubscribe => { if (this.accepting) this.unsubscribeReplies = unsubscribe; else unsubscribe(); }));
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
          const stopped = await this.conversations.stop(`telegram:${this.identity.botId}:${message.chatId}:${message.messageId}:stop`);
          this.feedback(message, stopped ? "Stop requested." : "No reply to stop.");
        } catch { this.feedback(message, "Couldn't stop the reply. Try /stop again."); }
      } else this.track(this.command(message, match[1].toLowerCase()));
      return;
    }
    try { normalizeMessage(message.text); } catch { this.feedback(message, "Send a message with 1–12,000 characters."); return; }
    try {
      const baseline = await this.conversations.snapshot();
      const result = await this.conversations.submit(message.text, `telegram:${this.identity.botId}:${message.chatId}:${message.messageId}`, { channel: "telegram", botId: this.identity.botId, chatId: message.chatId });
      if (result.duplicate) return;
      const known = new Set(baseline.messages.filter(item => item.role === "assistant" && !item.id.startsWith("live-")).map(item => item.id));
      this.startDelivery(message.chatId, known);
    } catch (error) {
      if (error instanceof RuntimeBusyError) { this.feedback(message, "Piko is busy. Try again when it's ready."); return; }
      throw error;
    }
  }

  private startDelivery(chatId: string, known: Set<string>) {
    if (this.deliveries.has(chatId)) return;
    const task = deliverConversation(this.conversations, this.api, chatId, this.controller.signal, known, this.intervalMs, true, async () => {
      const pending = this.pendingReports.get(chatId);
      if (!pending?.size) return true;
      const session = await this.conversations.get();
      for (const id of [...pending]) {
        const receipt = await session.submission(id);
        if (receipt?.status === "done" || receipt?.status === "unanswered") pending.delete(id);
      }
      return pending.size === 0;
    })
      .finally(() => { if (this.deliveries.get(chatId) === task) this.deliveries.delete(chatId); this.pendingReports.delete(chatId); });
    this.deliveries.set(chatId, task); this.track(task);
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
    if (command === "start" || command === "help") text = HELP;
    else if (command === "status") {
      const snapshot = await this.conversations.snapshot();
      text = `Status: ${snapshot.busy ? "Replying" : "Ready"}` + (snapshot.interruption ? `\n${snapshot.interruption}` : "") +
        (snapshot.latest?.status === "unanswered" ? `\nLast input: ${snapshot.latest.error === "aborted" ? "Stopped" : "Failed"}` : "");
      const description = await this.runtime.describe();
      text += `\n${selectionText(description)}\nSkills: ${description.skills.length}`;
    } else if (command === "models" || command === "thinking") {
      await this.menus.open(message, command); return;
    } else if (command === "compact") {
      const result = await this.conversations.changeRuntime(async () => {
        this.feedback(message, "Compacting context…");
        return this.runtime.compact();
      });
      text = result.status === "compacted" ? "Context compacted. Your chat history is preserved."
        : result.status === "cancelled" ? "Compaction stopped."
        : result.reason === "stale" ? "Context changed. The summary wasn't applied."
        : "Context unchanged. No summary created.";
      const description = await this.runtime.describe();
      text += `\n${selectionText(description)}`;
    } else if (command === "recent") {
      const history = (await this.conversations.snapshot()).messages;
      text = history.slice(-10).map(item => `${item.role === "user" ? "You" : "Piko"}:\n${item.content}`).join("\n\n") || "No messages yet.";
    } else if (command === "skills") {
      const description = await this.runtime.describe();
      text = description.skills.map(item => `${item.name} — ${item.description}`).join("\n") || "No skills available.";
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

  stopAccepting(): void { this.accepting = false; this.unsubscribeReplies?.(); }

  async drain(timeoutMs = 3000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.all([...this.tasks]), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
    finally { clearTimeout(timer); this.controller.abort(); }
  }
}
