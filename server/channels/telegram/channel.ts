import type { ConversationStore } from "../../chat/conversations";
import type { CompactionEvent } from "../../../shared/runtime";
import { CompactionExecutionError, RuntimeBusyError, type ChatRuntime } from "../../runtime/types";
import { normalizeMessage } from "../../chat/input";
import { MAX_ATTACHMENTS, type StreamEvent } from "../../../shared/chat";
import { toolIcon } from "../../runtime/tool-activity";
import { SUMMARY_TEXT_LIMIT, singleLine } from "../../runtime/text";
import type { AttachmentStore } from "../../attachments";
import { telegramErrorCode, type TelegramTransport } from "./api";
import { withTelegramQuote } from "./quote";
import { deliverConversation, TelegramReply, TELEGRAM_STREAM_INTERVAL_MS } from "./output";
import { TelegramMenus, TelegramMenuError, type TelegramCallback } from "./menus";
import { TelegramSubagentMenus } from "./subagent-menu";
import { TelegramSkillMenus } from "./skills-menu";
import { TelegramTaskMenus } from "./task-menu";
import { WELCOME, busyMessage, formatCompaction, formatHelp, formatRecent, formatStatus } from "./command-format";
export { TELEGRAM_COMMANDS } from "./command-format";

export type TelegramMessage = {
  chatId: string; messageId: string; actorId: string; chatType: string; text?: string; replyText?: string;
  /** Photos and image documents; the channel downloads them into the shared attachment store. */
  attachments?: { fileId: string; name?: string; mime?: string }[];
  topic?: boolean; business?: boolean;
};

export class TelegramChannel {
  private accepting = true;
  private notificationChatId?: string;
  private readonly compactionReady: Promise<void>;
  private unsubscribeCompactions?: () => void;
  private unsubscribeOutput?: () => void;
  private compactionQueue: Promise<void> = Promise.resolve();
  private readonly controller = new AbortController();
  private readonly tasks = new Set<Promise<void>>();
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly menus: TelegramMenus;
  private readonly subagentMenus: TelegramSubagentMenus;
  private readonly skillMenus: TelegramSkillMenus;
  private readonly taskMenus: TelegramTaskMenus;
  private pendingReports = new Map<string, Set<string>>();
  private unsubscribeReplies?: () => void;
  private unsubscribeTools?: () => void;
  private toolQueue = Promise.resolve();
  private readonly toolLines = new Map<string, string>();
  private readonly pendingToolClears = new Set<string>();
  private readonly deliveryExpectations = new Map<string, number>();
  private toolReply?: TelegramReply;
  private readonly stopNoticeSuppressions = new Map<string, Set<string>>();
  private outputSeeded = false;
  private readonly outputMessages = new Map<string, string>();
  constructor(private readonly identity: { botId: string; username: string; userId: string },
    private readonly conversations: ConversationStore, private readonly runtime: ChatRuntime,
    private readonly api: TelegramTransport, private readonly store: AttachmentStore,
    private readonly intervalMs = TELEGRAM_STREAM_INTERVAL_MS) {
    this.menus = new TelegramMenus(conversations, runtime, api);
    this.subagentMenus = new TelegramSubagentMenus(runtime, api);
    this.skillMenus = new TelegramSkillMenus(runtime, api);
    this.taskMenus = new TelegramTaskMenus(runtime, api);
    this.compactionReady = conversations.subscribeCompactions(event => this.queueCompaction(event))
      .then(unsubscribe => { if (this.accepting) this.unsubscribeCompactions = unsubscribe; else unsubscribe(); });
    this.track(this.compactionReady);
    this.track(conversations.observe(event => this.observeConversationOutput(event))
      .then(unsubscribe => { if (this.accepting) this.unsubscribeOutput = unsubscribe; else unsubscribe(); }));
    this.track(conversations.subscribeBackgroundReplies(async reply => {
      if (!this.accepting) return;
      // Main-conversation output is broadcast regardless of the input channel.
      const chatId = this.identity.userId;
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
    } else if (callback.data.startsWith("k:")) {
      this.track(this.skillMenus.handle(callback));
    } else if (callback.data.startsWith("t:")) {
      this.track(this.taskMenus.handle(callback));
    } else {
      this.track(this.menus.handle(callback).catch(async error => {
        if (!(error instanceof TelegramMenuError)) throw error;
        await this.api.answerCallback(callback.callbackId, error.message, false);
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
        let submissionId: string | undefined;
        let addedSuppression = false;
        try {
          const snapshot = await this.conversations.snapshot();
          if (snapshot.latest?.status === "queued" || snapshot.latest?.status === "placed") {
            submissionId = snapshot.latest.id;
            addedSuppression = this.addStopNoticeSuppression(message.chatId, submissionId);
          }
          const stopped = await this.conversations.stop(`telegram:${this.identity.botId}:${message.chatId}:${message.messageId}:stop`);
          if (!stopped && addedSuppression && submissionId) this.removeStopNoticeSuppression(message.chatId, submissionId);
          this.feedback(message, stopped ? "Stopped." : "Nothing to stop.");
        } catch {
          if (addedSuppression && submissionId) this.removeStopNoticeSuppression(message.chatId, submissionId);
          this.feedback(message, "Couldn't stop. Try again.");
        }
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
    let prompt: string;
    try {
      const normalized = normalizeMessage(text, paths.length > 0);
      prompt = normalizeMessage(withTelegramQuote(normalized, message.replyText), paths.length > 0);
    } catch {
      this.feedback(message, "Send a message with 1–12,000 characters.");
      return;
    }
    let expectedDelivery = false;
    try {
      const baseline = await this.conversations.snapshot();
      this.expectDelivery(message.chatId);
      expectedDelivery = true;
      const result = await this.conversations.submit(prompt, `telegram:${this.identity.botId}:${message.chatId}:${message.messageId}`, { channel: "telegram", botId: this.identity.botId, chatId: message.chatId }, paths);
      if (result.duplicate) return;
      const known = new Set(baseline.messages.filter(item => item.role === "assistant" && !item.id.startsWith("live-")).map(item => item.id));
      this.startDelivery(message.chatId, known);
    } catch (error) {
      if (error instanceof RuntimeBusyError) { this.feedback(message, "Piko is busy with maintenance. Wait for it to finish, then resend your message."); return; }
      throw error;
    } finally {
      if (expectedDelivery) await this.releaseDeliveryExpectation(message.chatId);
    }
  }

  /** Main-conversation assistant messages are delivered to Telegram regardless of input source. */
  private observeConversationOutput(event: StreamEvent): void {
    if (!this.accepting) return;
    if (event.type === "snapshot") {
      const messages = event.conversation.messages.filter(message => message.role === "assistant");
      if (!this.outputSeeded) {
        this.outputSeeded = true;
        const known = new Set(messages
          .filter(message => !event.conversation.busy || !message.id.startsWith("live-"))
          .map(message => message.id));
        if (event.conversation.busy && messages.some(message => message.id.startsWith("live-") && message.content.trim()))
          this.startDelivery(this.identity.userId, known);
      } else {
        const known = new Set(this.outputMessages.keys());
        const changed = messages.filter(message => this.outputMessages.get(message.id) !== message.content);
        if (changed.length) {
          for (const message of changed) known.delete(message.id);
          this.startDelivery(this.identity.userId, known);
        }
      }
      this.outputMessages.clear();
      for (const message of messages) this.outputMessages.set(message.id, message.content);
      return;
    }
    if (event.type !== "message" || event.message.role !== "assistant" || !this.outputSeeded) return;
    if (this.outputMessages.get(event.message.id) === event.message.content) return;
    const known = new Set(this.outputMessages.keys());
    known.delete(event.message.id);
    this.startDelivery(this.identity.userId, known);
    this.outputMessages.set(event.message.id, event.message.content);
  }

  private queueCompaction(event: CompactionEvent) {
    const chatId = this.notificationChatId;
    // Automatic threshold/overflow compactions are invisible maintenance, not a new chat message.
    if (!this.accepting || !chatId || event.reason !== "manual") return;
    // Serial sends preserve start/end order even when a compaction finishes before Telegram accepts the first notice.
    this.compactionQueue = this.compactionQueue.then(async () => { await this.api.send(chatId, formatCompaction(event), false); })
      .catch(error => console.warn(`Telegram compaction notification failed (${telegramErrorCode(error)}).`));
  }

  private queueTool(event: Extract<StreamEvent, { type: "tool" } | { type: "tool-clear" }>): void {
    this.toolQueue = this.toolQueue.then(() => this.handleToolActivity(event))
      .catch(error => console.warn(`Telegram tool activity failed (${telegramErrorCode(error)}).`));
  }

  /** Aggregate a run's tool starts into one temporary status message. */
  private async handleToolActivity(event: Extract<StreamEvent, { type: "tool" } | { type: "tool-clear" }>): Promise<void> {
    const chatId = this.identity.userId;
    if (event.type === "tool-clear") {
      if (this.deliveries.has(chatId) || (this.deliveryExpectations.get(chatId) ?? 0) > 0) {
        this.pendingToolClears.add(chatId);
        return;
      }
      await this.clearToolMessages();
      return;
    }
    if (!this.accepting || event.activity.status !== "running") return;
    const { name, summary } = event.activity;
    this.toolLines.set(event.activity.callId, singleLine(
      `${toolIcon(name)} ${name}${summary ? `: ${summary}` : ""}`,
      SUMMARY_TEXT_LIMIT,
    )!);
    this.toolReply ??= new TelegramReply(this.api, chatId, "plain");
    await this.toolReply.update([...this.toolLines.values()].join("\n"), true);
  }

  private async clearToolMessages(): Promise<void> {
    this.toolLines.clear();
    const reply = this.toolReply;
    this.toolReply = undefined;
    await reply?.deleteMessages();
  }

  private expectDelivery(chatId: string): void {
    this.deliveryExpectations.set(chatId, (this.deliveryExpectations.get(chatId) ?? 0) + 1);
  }

  private async releaseDeliveryExpectation(chatId: string): Promise<void> {
    const remaining = (this.deliveryExpectations.get(chatId) ?? 1) - 1;
    if (remaining > 0) this.deliveryExpectations.set(chatId, remaining);
    else this.deliveryExpectations.delete(chatId);
    if (remaining <= 0 && !this.deliveries.has(chatId) && this.pendingToolClears.delete(chatId))
      await this.clearToolMessages();
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
    }, submissionId => this.shouldNotifyStopped(chatId, submissionId))
      .finally(async () => {
        if (this.deliveries.get(chatId) === task) this.deliveries.delete(chatId);
        this.pendingReports.delete(chatId);
        this.stopNoticeSuppressions.delete(chatId);
        if (this.pendingToolClears.delete(chatId)) await this.clearToolMessages();
      });
    this.deliveries.set(chatId, task); this.track(task);
  }
  private addStopNoticeSuppression(chatId: string, submissionId: string): boolean {
    const requests = this.stopNoticeSuppressions.get(chatId) ?? new Set<string>();
    const added = !requests.has(submissionId);
    requests.add(submissionId);
    this.stopNoticeSuppressions.set(chatId, requests);
    return added;
  }

  private removeStopNoticeSuppression(chatId: string, submissionId: string): void {
    const requests = this.stopNoticeSuppressions.get(chatId);
    if (!requests?.delete(submissionId)) return;
    if (!requests.size) this.stopNoticeSuppressions.delete(chatId);
  }

  private shouldNotifyStopped(chatId: string, submissionId: string): boolean {
    const requests = this.stopNoticeSuppressions.get(chatId);
    if (!requests?.delete(submissionId)) return true;
    if (!requests.size) this.stopNoticeSuppressions.delete(chatId);
    return false;
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
    } else if (command === "task") {
      await this.taskMenus.open(message); return;
    } else if (command === "skills") {
      await this.skillMenus.open(message); return;
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

  stopAccepting(): void { this.accepting = false; this.unsubscribeReplies?.(); this.unsubscribeTools?.(); this.unsubscribeCompactions?.(); this.unsubscribeOutput?.(); }

  async drain(timeoutMs = 3000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.all([...this.tasks, this.toolQueue, this.compactionQueue]), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
    finally { clearTimeout(timer); this.controller.abort(); }
  }
}
