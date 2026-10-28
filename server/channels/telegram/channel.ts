import type { ConversationStore } from "../../chat/conversations";
import { CompactionExecutionError, ModelConfigurationError, RuntimeBusyError, type ChatRuntime } from "../../runtime/types";
import { normalizeMessage } from "../../chat/input";
import { MAX_ATTACHMENTS } from "../../../shared/chat";
import type { AttachmentStore } from "../../attachments";
import { telegramErrorCode, type TelegramTransport } from "./api";
import { withTelegramQuote } from "./quote";
import { TelegramReply, TELEGRAM_STREAM_INTERVAL_MS } from "./output";
import { TelegramConversationOutput } from "./conversation-output";
import { TelegramMenus, TelegramMenuError, type TelegramCallback } from "./menus";
import { TelegramSubagentMenus } from "./subagent-menu";
import { TelegramSkillMenus } from "./skills-menu";
import { TelegramTaskMenus } from "./task-menu";
import { WELCOME, busyMessage, formatHelp, formatRecent, formatStatus } from "./command-format";
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
  private readonly outputReady: Promise<void>;
  private unsubscribeOutput?: () => void;
  private readonly output: TelegramConversationOutput;
  private readonly tasks = new Set<Promise<void>>();
  private readonly menus: TelegramMenus;
  private readonly subagentMenus: TelegramSubagentMenus;
  private readonly skillMenus: TelegramSkillMenus;
  private readonly taskMenus: TelegramTaskMenus;
  private unsubscribeReplies?: () => void;
  constructor(private readonly identity: { botId: string; username: string; userId: string },
    private readonly conversations: ConversationStore, private readonly runtime: ChatRuntime,
    private readonly api: TelegramTransport, private readonly store: AttachmentStore,
    private readonly intervalMs = TELEGRAM_STREAM_INTERVAL_MS) {
    this.menus = new TelegramMenus(conversations, runtime, api);
    this.subagentMenus = new TelegramSubagentMenus(runtime, api);
    this.skillMenus = new TelegramSkillMenus(runtime, api);
    this.taskMenus = new TelegramTaskMenus(runtime, api);
    this.output = new TelegramConversationOutput(api, identity.userId, intervalMs, () => !!this.notificationChatId);
    this.outputReady = conversations.observeRuntime(event => this.output.accept(event))
      .then(unsubscribe => { if (this.accepting) this.unsubscribeOutput = unsubscribe; else unsubscribe(); });
    this.track(this.outputReady);
    this.track(conversations.subscribeBackgroundReplies(async () => {
      if (this.accepting) this.output.wake();
    }).then(unsubscribe => { if (this.accepting) this.unsubscribeReplies = unsubscribe; else unsubscribe(); }));
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
        let cancelSuppression: (() => void) | undefined;
        try {
          await this.outputReady;
          cancelSuppression = this.output.suppressStopNotice();
          const stopped = await this.conversations.stop(`telegram:${this.identity.botId}:${message.chatId}:${message.messageId}:stop`);
          if (!stopped) cancelSuppression();
          this.feedback(message, stopped ? "Stopped." : "Nothing to stop.");
        } catch {
          cancelSuppression?.();
          this.feedback(message, "Couldn't stop. Try again.");
        }
      } else this.track(this.command(message, match[1].toLowerCase()));
      return;
    }
    try {
      if (!(await this.runtime.isModelReady())) {
        const settings = await this.runtime.settings();
        if (!settings.mainModel)
          this.feedback(message, "尚未选择主模型。请先发送 /models 选择模型，再重新发送消息。");
        else
          this.feedback(message, "当前主模型不可用，请检查部署中的模型目录和凭据后重试。");
        return;
      }
    } catch {
      this.feedback(message, "暂时无法确认主模型状态，请稍后重试。");
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
    try {
      await this.outputReady;
      await this.conversations.submit(prompt, `telegram:${this.identity.botId}:${message.chatId}:${message.messageId}`, { channel: "telegram", botId: this.identity.botId, chatId: message.chatId }, paths);
    } catch (error) {
      if (error instanceof RuntimeBusyError) { this.feedback(message, "Piko is busy with maintenance. Wait for it to finish, then resend your message."); return; }
      if (error instanceof ModelConfigurationError) {
        this.feedback(message, error.message.startsWith("尚未选择主模型")
          ? "尚未选择主模型。请先发送 /models 选择模型，再重新发送消息。"
          : error.message);
        return;
      }
      throw error;
    }
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
      await this.outputReady;
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

  stopAccepting(): void { this.accepting = false; this.unsubscribeReplies?.(); this.unsubscribeOutput?.(); }

  async drain(timeoutMs = 3000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.all([...this.tasks, this.output.close(timeoutMs)]), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
}
