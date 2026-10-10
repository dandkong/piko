import type { ConversationStore } from "../../chat/conversations";
import type { ChatRuntime } from "../../runtime/types";
import { telegramErrorCode, type TelegramTransport } from "./api";
import { deliverRun, TelegramReply, TELEGRAM_STREAM_INTERVAL_MS } from "./output";

export type TelegramMessage = {
  chatId: string; messageId: string; actorId: string; chatType: string; text?: string;
  topic?: boolean; business?: boolean;
};

export const TELEGRAM_COMMANDS = [
  { command: "start", description: "使用 Piko" }, { command: "help", description: "查看帮助" },
  { command: "status", description: "查看共享主会话状态" }, { command: "stop", description: "停止当前回复（包括 RN 发起的回复）" },
  { command: "recent", description: "最近 10 条聊天消息" }, { command: "skills", description: "查看技能" },
  { command: "plugins", description: "查看插件" },
];
const HELP = "Piko 与 RN 共用工作区、主会话和上下文。直接发送文本即可交流。\n" +
  "一次执行一个请求，忙碌时的新消息不会排队。/stop 也会停止 RN 发起的回复。\n" +
  "RN 的回复不会主动推送到这里；/recent 可查看最近历史。首期不支持附件、群聊、语音或会话切换。\n\n" +
  TELEGRAM_COMMANDS.map(item => `/${item.command} — ${item.description}`).join("\n");

export class TelegramChannel {
  private accepting = true;
  private readonly controller = new AbortController();
  private readonly tasks = new Set<Promise<void>>();
  private readonly deliveries = new Set<string>();
  constructor(private readonly identity: { botId: string; username: string; userId: string },
    private readonly conversations: ConversationStore, private readonly runtime: ChatRuntime,
    private readonly api: TelegramTransport, private readonly intervalMs = TELEGRAM_STREAM_INTERVAL_MS) {}

  async handle(message: TelegramMessage): Promise<void> {
    if (!this.accepting || message.actorId !== this.identity.userId || message.chatType !== "private" ||
      message.topic || message.business) return;
    if (message.text === undefined) { this.feedback(message, "首期只支持文本消息；附件和语音尚未接入。"); return; }
    const text = message.text.trim();
    if (text.startsWith("/")) {
      const match = /^\/([a-zA-Z_]+)(?:@([\w]+))?(?:\s.*)?$/.exec(text);
      if (!match || match[2] && match[2].toLowerCase() !== this.identity.username.toLowerCase()) {
        this.feedback(message, "不支持此命令。使用 /help 查看可用命令。"); return;
      }
      // Stop admission/control is awaited; network presentation is always independent.
      if (match[1].toLowerCase() === "stop") {
        try {
          const stopped = await this.conversations.stopTelegram({ botId: this.identity.botId, chatId: message.chatId,
            messageId: message.messageId, actorId: message.actorId }, text);
          this.feedback(message, stopped ? "已请求停止对应的主会话回复。" : "此命令接收时没有正在执行的回复。");
        } catch { this.feedback(message, "停止失败，请稍后重新发送 /stop。"); }
      } else this.track(this.command(message, match[1].toLowerCase()));
      return;
    }
    const result = await this.conversations.startTelegram({ botId: this.identity.botId, chatId: message.chatId,
      messageId: message.messageId, actorId: message.actorId }, message.text);
    if (result.disposition === "busy") this.feedback(message, "主会话正在回复。请等待或使用 /stop；此消息未排队，请稍后重新发送。");
    else if (result.disposition === "invalid") this.feedback(message, "消息必须包含 1–12,000 个字符。");
    else if (result.run && !result.duplicate && !this.deliveries.has(result.run.snapshot.id)) {
      const id = result.run.snapshot.id;
      this.deliveries.add(id);
      this.track(deliverRun(result.run, new TelegramReply(this.api, message.chatId, message.messageId), this.api,
        message.chatId, this.controller.signal, this.intervalMs).finally(() => this.deliveries.delete(id)));
    } else if (result.duplicate) {
      this.feedback(message, "此消息已处理，不会重复执行。回复可在 RN 或 /recent 查看。");
    }
  }

  private async command(message: TelegramMessage, command: string): Promise<void> {
    let text: string;
    const sessionId = this.conversations.main.sessionId;
    if (command === "start" || command === "help") text = HELP;
    else if (command === "status") {
      const run = await this.conversations.run(sessionId);
      text = `主会话：${sessionId}\n状态：${run?.active ? run.snapshot.status : this.conversations.isStreaming(sessionId) ? "运行时操作中" : "空闲"}` +
        (run ? `\n最近回复：${run.snapshot.status}${run.snapshot.errorCode === "interrupted" ? "（后端重启中断，请重新发送）" : ""}` : "");
    } else if (command === "recent") {
      const history = await this.conversations.history(sessionId);
      text = history.slice(-10).map(item => `${item.role === "user" ? "你" : "Piko"}：\n${item.content}`).join("\n\n") || "主会话还没有聊天记录。";
      const run = await this.conversations.run(sessionId);
      if (run?.active && run.snapshot.text) text += `\n\nPiko（回复中）：\n${run.snapshot.text}`;
    } else if ((command === "skills" || command === "plugins") && this.runtime.describe) {
      const description = await this.runtime.describe(this.conversations.context());
      text = command === "skills" ? description.skills.map(item => `${item.name} — ${item.description}`).join("\n") || "没有可用技能。"
        : description.plugins.map(item => `${item.name}${item.tools.length ? ` — ${item.tools.join(", ")}` : ""}`).join("\n") || "没有已加载插件。";
    } else text = "不支持此命令。使用 /help 查看可用命令。";
    await new TelegramReply(this.api, message.chatId, message.messageId, "plain").update(text, true);
  }

  private feedback(message: TelegramMessage, text: string): void {
    this.track(new TelegramReply(this.api, message.chatId, message.messageId, "plain").update(text, true));
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
