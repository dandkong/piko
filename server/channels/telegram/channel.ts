import type { ConversationStore } from "../../chat/conversations";
import type { CompactionEvent } from "../../../shared/runtime";
import { CompactionExecutionError, RuntimeBusyError, type ChatRuntime } from "../../runtime/types";
import { normalizeMessage } from "../../chat/input";
import { MAX_ATTACHMENTS, type StreamEvent } from "../../../shared/chat";
import { toolDisplayName, toolIcon } from "../../runtime/tool-activity";
import type { AttachmentStore } from "../../attachments";
import { telegramErrorCode, type TelegramTransport } from "./api";
import { deliverConversation, TelegramReply, TELEGRAM_STREAM_INTERVAL_MS } from "./output";
import { TelegramMenus, TelegramMenuError, type TelegramCallback } from "./menus";
import { TelegramSubagentMenus } from "./subagent-menu";
import { WELCOME, busyMessage, formatCompaction, formatHelp, formatRecent, formatStatus } from "./command-format";
export { TELEGRAM_COMMANDS } from "./command-format";

export type TelegramMessage = {
  chatId: string; messageId: string; actorId: string; chatType: string; text?: string;
  /** Photos and image documents; the channel downloads them into the shared attachment store. */
  attachments?: { fileId: string; name?: string; mime?: string }[];
  topic?: boolean; business?: boolean;
};

export class TelegramChannel {
  private accepting = true;
  private notificationChatId?: string;
  private readonly compactionReady: Promise<void>;
  private unsubscribeCompactions?: () => void;
  private compactionQueue: Promise<void> = Promise.resolve();
  private readonly controller = new AbortController();
  private readonly tasks = new Set<Promise<void>>();
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly menus: TelegramMenus;
  private readonly subagentMenus: TelegramSubagentMenus;
  private pendingReports = new Map<string, Set<string>>();
  private unsubscribeReplies?: () => void;
  private unsubscribeTools?: () => void;
  private toolQueue = Promise.resolve();
  private readonly toolMessages = new Map<string, string>();
  constructor(private readonly identity: { botId: string; username: string; userId: string },
    private readonly conversations: ConversationStore, private readonly runtime: ChatRuntime,
    private readonly api: TelegramTransport, private readonly store: AttachmentStore,
    private readonly intervalMs = TELEGRAM_STREAM_INTERVAL_MS) {
    this.menus = new TelegramMenus(conversations, runtime, api);
    this.subagentMenus = new TelegramSubagentMenus(runtime, api);
    this.compactionReady = conversations.subscribeCompactions(event => this.queueCompaction(event))
      .then(unsubscribe => { if (this.accepting) this.unsubscribeCompactions = unsubscribe; else unsubscribe(); });
    this.track(this.compactionReady);
    this.track(conversations.subscribeBackgroundReplies(async reply => {
      if (!this.accepting) return;
      // Scheduled work broadcasts to every channel; ordinary background work answers where it started.
      const chatId = reply.deliver === "all" ? this.identity.userId
        : reply.source.channel === "telegram" && reply.source.botId === this.identity.botId && reply.source.chatId === this.identity.userId
          ? reply.source.chatId : undefined;
      if (!chatId) return;
      const pending = this.pendingReports.get(chatId) ?? new Set<string>(); pending.add(reply.requestId); this.pendingReports.set(chatId, pending);
      this.startDelivery(chatId, new Set(reply.knownMessageIds));
    }).then(unsubscribe => { if (this.accepting) this.unsubscribeReplies = unsubscribe; else unsubscribe(); }));
    void conversations.subscribeToolActivity(event => this.queueTool(event))
      .then(unsubscribe => { if (this.accepting) this.unsubscribeTools = unsubscribe; else unsubscribe(); })
      .catch(error => console.warn("Telegram tool activity subscription failed:", error instanceof Error ? error.message : "failed"));
  }

  handleCallback(callback: TelegramCallback): void {
    if (!this.accepting || callback.actorId !== this.identity.userId || callback.chatType !== "private" ||
      callback.topic || callback.business) return;
    this.notificationChatId = callback.chatId;
    if (callback.data.startsWith("s:")) {
      this.track(this.subagentMenus.handle(callback));
    } else {
      this.track(this.menus.handle(callback).catch(async error => {
        if (!(error instanceof TelegramMenuError)) throw error;
        await this.api.answerCallback(callback.callbackId, error.message, true);
      }));
    }
  }

  async handle(message: TelegramMessage): Promise<void> {
    if (!this.accepting || message.actorId !== this.identity.userId || message.chatType !== "private" ||
      message.topic || message.business) return;
    this.notificationChatId = message.chatId;
    const text = message.text?.trim() ?? "";
    const incoming = message.attachments ?? [];
    if (!text && !incoming.length) { this.feedback(message, "Please send a text or a file."); return; }
    if (text.startsWith("/")) {
      const match = /^\/([a-zA-Z_]+)(?:@([\w]+))?(?:\s.*)?$/.exec(text);
      if (!match || match[2] && match[2].toLowerCase() !== this.identity.username.toLowerCase()) {
        this.feedback(message, "Unknown command. Use /help to see what's available."); return;
      }
      // Stop admission/control is awaited; network presentation is always independent.
      if (match[1].toLowerCase() === "stop") {
        try {
          const stopped = await this.conversations.stop(`telegram:${this.identity.botId}:${message.chatId}:${message.messageId}:stop`);
          this.feedback(message, stopped ? "Current reply or maintenance stopped. Background work is unchanged." : "Nothing to stop — no reply or maintenance is running.");
        } catch { this.feedback(message, "Couldn't stop the reply. Try /stop again."); }
      } else this.track(this.command(message, match[1].toLowerCase()));
      return;
    }
    const paths: string[] = [];
    if (incoming.length) {
      try {
        for (const item of incoming.slice(0, MAX_ATTACHMENTS)) paths.push((await this.store.save({
          bytes: await this.api.download(item.fileId), name: item.name, mime: item.mime })).path);
      } catch { this.feedback(message, "Couldn't read that file. Send it again under 20 MB."); return; }
    }
    try { normalizeMessage(text, paths.length > 0); } catch { this.feedback(message, "Send a message with 1–12,000 characters."); return; }
    try {
      const baseline = await this.conversations.snapshot();
      const result = await this.conversations.submit(text, `telegram:${this.identity.botId}:${message.chatId}:${message.messageId}`, { channel: "telegram", botId: this.identity.botId, chatId: message.chatId }, paths);
      if (result.duplicate) return;
      const known = new Set(baseline.messages.filter(item => item.role === "assistant" && !item.id.startsWith("live-")).map(item => item.id));
      this.startDelivery(message.chatId, known);
    } catch (error) {
      if (error instanceof RuntimeBusyError) { this.feedback(message, "Piko is busy with maintenance. Wait for it to finish, then resend your message."); return; }
      throw error;
    }
  }

  private queueCompaction(event: CompactionEvent) {
    const chatId = this.notificationChatId;
    if (!this.accepting || !chatId) return;
    // Serial sends preserve start/end order even when a compaction finishes before Telegram accepts the first notice.
    this.compactionQueue = this.compactionQueue.then(async () => { await this.api.send(chatId, formatCompaction(event), false); })
      .catch(error => console.warn(`Telegram compaction notification failed (${telegramErrorCode(error)}).`));
  }

  private queueTool(event: Extract<StreamEvent, { type: "tool" } | { type: "tool-clear" }>): void {
    this.toolQueue = this.toolQueue.then(() => this.handleToolActivity(event))
      .catch(error => console.warn(`Telegram tool activity failed (${telegramErrorCode(error)}).`));
  }

  /** Shows each call while the run is active; the whole round is removed when it settles. */
  private async handleToolActivity(event: Extract<StreamEvent, { type: "tool" } | { type: "tool-clear" }>): Promise<void> {
    if (event.type === "tool-clear") { await this.deleteToolMessages(); return; }
    if (!this.accepting || event.activity.status !== "running") return;
    const { name, summary } = event.activity;
    const messageId = await this.api.send(this.identity.userId, `${toolIcon(name)} ${toolDisplayName(name)}${summary ? `: ${summary}` : ""}`, false);
    this.toolMessages.set(event.activity.callId, messageId);
  }

  private async deleteToolMessages(): Promise<void> {
    const ids = [...this.toolMessages.values()].reverse();
    this.toolMessages.clear();
    for (const messageId of ids) {
      try { await this.api.remove(this.identity.userId, messageId); }
      catch { /* the message may already be gone or too old to delete */ }
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
      // Once admitted, the native lifecycle observer owns completion, cancellation and failure notices.
      if (error instanceof CompactionExecutionError) return;
      if (!(error instanceof RuntimeBusyError)) console.warn(`Telegram command failed (${telegramErrorCode(error)}).`);
      await new TelegramReply(this.api, message.chatId, "plain").update(error instanceof RuntimeBusyError
        ? busyMessage("compact")
        : command === "compact"
          ? "Couldn't confirm the compaction result. Your chat history is preserved. Check /status before retrying /compact."
          : `Couldn't open /${command}. Try again; if it keeps failing, check the Piko service.`, true);
    }
  }

  private async executeCommand(message: TelegramMessage, command: string): Promise<void> {
    let text: string;
    if (command === "start") text = WELCOME;
    else if (command === "help") text = formatHelp();
    else if (command === "status") {
      text = formatStatus(await this.conversations.snapshot(), await this.runtime.describe());
    } else if (command === "models" || command === "thinking") {
      await this.menus.open(message, command); return;
    } else if (command === "subagent") {
      await this.subagentMenus.open(message); return;
    } else if (command === "compact") {
      await this.compactionReady;
      const snapshot = await this.conversations.snapshot();
      if (snapshot.compactions?.length) text = "Compaction is already running. Wait for it to finish; /stop cancels foreground work.";
      else {
        if (snapshot.busy) throw new RuntimeBusyError();
        await this.conversations.changeRuntime(() => this.runtime.compact());
        return; // All lifecycle feedback comes from the runtime subscription, not this command.
      }
    } else if (command === "recent") {
      text = formatRecent((await this.conversations.snapshot({ limit: 50 })).messages);
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

  stopAccepting(): void { this.accepting = false; this.unsubscribeReplies?.(); this.unsubscribeTools?.(); this.unsubscribeCompactions?.(); }

  async drain(timeoutMs = 3000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.all([...this.tasks, this.toolQueue, this.compactionQueue]), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
    finally { clearTimeout(timer); this.controller.abort(); }
  }
}
