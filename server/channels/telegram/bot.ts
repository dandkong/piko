import { Bot } from "grammy";
import type { ConversationStore } from "../../chat/conversations";
import type { ChatRuntime } from "../../runtime/types";
import { TelegramApi, telegramErrorCode } from "./api";
import { richBlocksToPlainText } from "./quote";
import { TelegramChannel, TELEGRAM_COMMANDS } from "./channel";
import type { TelegramConfig } from "../../config";
import type { AttachmentStore } from "../../attachments";
import { MAX_ATTACHMENTS } from "../../../shared/chat";
import { logInfo, logWarn } from "../../logging";

export class TelegramBot {
  private readonly bot: Bot;
  private readonly api: TelegramApi;
  private readonly startupController = new AbortController();
  private channel?: TelegramChannel;
  private polling?: Promise<void>;
  private starting?: Promise<void>;
  private stopping = false;
  constructor(private readonly config: TelegramConfig, private readonly conversations: ConversationStore, private readonly runtime: ChatRuntime,
    private readonly attachments: AttachmentStore, bot?: Bot, private readonly onFailure?: () => void) {
    this.bot = bot ?? new Bot(config.token, { client: { timeoutSeconds: 10 } });
    this.api = new TelegramApi(this.bot);
    // A failed update is logged without taking down grammY's polling loop.
    this.bot.catch(error => logWarn("telegram.update.failed", { telegramCode: telegramErrorCode(error.error) }));
    this.bot.on("message", async ctx => {
      const message = ctx.msg;
      const photo = "photo" in message ? message.photo?.at(-1) : undefined;
      const document = "document" in message ? message.document : undefined;
      const video = "video" in message ? message.video : undefined;
      const audio = "audio" in message ? message.audio : undefined;
      const voice = "voice" in message ? message.voice : undefined;
      const caption = "caption" in message ? message.caption : undefined;
      const reply = message.reply_to_message;
      const replyText = [message.quote?.text, reply?.text, reply?.caption,
        reply?.rich_message && richBlocksToPlainText(reply.rich_message.blocks)]
        .find((text): text is string => typeof text === "string" && !!text.trim());
      // Whatever the user sends is stored and the path reaches the model; it decides how to inspect the file.
      const attachments = [
        ...(photo ? [{ fileId: photo.file_id, name: `photo-${Date.now()}.jpg`, mime: "image/jpeg" }] : []),
        ...(document ? [{ fileId: document.file_id, name: document.file_name, mime: document.mime_type }] : []),
        ...(video ? [{ fileId: video.file_id, name: video.file_name ?? `video-${Date.now()}.mp4`, mime: video.mime_type }] : []),
        ...(audio ? [{ fileId: audio.file_id, name: audio.file_name ?? `audio-${Date.now()}.mp3`, mime: audio.mime_type }] : []),
        ...(voice ? [{ fileId: voice.file_id, name: `voice-${Date.now()}.ogg`, mime: voice.mime_type ?? "audio/ogg" }] : []),
      ].slice(0, MAX_ATTACHMENTS);
      await this.channel?.handle({ chatId: String(ctx.chat.id), messageId: String(message.message_id),
        actorId: String(ctx.from?.id ?? ""), chatType: ctx.chat.type, text: message.text ?? caption, replyText, attachments,
        topic: message.message_thread_id !== undefined || message.is_topic_message,
        business: message.business_connection_id !== undefined || message.guest_query_id !== undefined });
    });
    this.bot.on("callback_query:data", ctx => {
      const message = ctx.callbackQuery.message;
      if (!message || message.date === 0) return;
      this.channel?.handleCallback({ callbackId: ctx.callbackQuery.id, data: ctx.callbackQuery.data,
        actorId: String(ctx.callbackQuery.from.id), chatId: String(message.chat.id),
        messageId: String(message.message_id), chatType: message.chat.type,
        topic: message.message_thread_id !== undefined || message.is_topic_message,
        business: message.business_connection_id !== undefined || message.guest_query_id !== undefined });
    });
  }

  start(): Promise<void> {
    return this.starting ??= this.initialize().catch(error => this.failed(error));
  }

  private async initialize(): Promise<void> {
    const signal = this.startupController.signal as unknown as typeof this.api.signal;
    await this.bot.init(signal);
    if (this.stopping) return;
    await this.bot.api.setMyCommands(TELEGRAM_COMMANDS, {}, signal);
    if (this.stopping) return;
    this.channel = new TelegramChannel({ botId: String(this.bot.botInfo.id), username: this.bot.botInfo.username!, userId: this.config.userId },
      this.conversations, this.runtime, this.api, this.attachments);
    // grammY owns the cursor, webhook removal and persistent polling retries.
    this.polling = this.bot.start({ timeout: 5, allowed_updates: ["message", "callback_query"],
      onStart: () => { logInfo("telegram.polling.started"); },
    }).catch(error => this.failed(error));
  }

  private failed(error: unknown): void {
    if (this.stopping) return;
    this.channel?.stopAccepting();
    // Never log the SDK error itself: its request URL may contain the token.
    logWarn("telegram.polling.failed", { telegramCode: telegramErrorCode(error) });
    this.onFailure?.();
  }

  async stopInput(): Promise<void> {
    this.stopping = true;
    this.channel?.stopAccepting();
    this.startupController.abort();
    await this.starting;
    try { if (this.bot.isRunning()) await this.bot.stop(); }
    finally { await this.polling; }
  }

  async close(): Promise<void> {
    await this.channel?.drain();
    this.api.controller.abort();
  }
}
