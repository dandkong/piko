import { Bot, GrammyError } from "grammy";
import type { ConversationStore } from "../../chat/conversations";
import type { ChatRuntime } from "../../runtime/types";
import { TelegramApi, telegramErrorCode, telegramRequest } from "./api";
import { TelegramChannel, TELEGRAM_COMMANDS } from "./channel";
import type { TelegramConfig } from "../../config";

export class TelegramBot {
  private readonly bot: Bot;
  private readonly api: TelegramApi;
  private readonly pollingController = new AbortController();
  private channel?: TelegramChannel;
  private polling?: Promise<void>;
  private starting?: Promise<void>;
  private stopping = false;
  constructor(private readonly config: TelegramConfig, private readonly conversations: ConversationStore, private readonly runtime: ChatRuntime, bot?: Bot) {
    this.bot = bot ?? new Bot(config.token, { client: { timeoutSeconds: 10 } });
    this.api = new TelegramApi(this.bot);
    this.bot.on("message", async ctx => {
      await this.channel?.handle({ chatId: String(ctx.chat.id), messageId: String(ctx.msg.message_id),
        actorId: String(ctx.from?.id ?? ""), chatType: ctx.chat.type, text: ctx.msg.text,
        topic: ctx.msg.message_thread_id !== undefined || ctx.msg.is_topic_message,
        business: ctx.msg.business_connection_id !== undefined || ctx.msg.guest_query_id !== undefined });
    });
  }

  start(): Promise<void> {
    return this.starting ??= this.initialize().catch(error => {
      if (this.stopping) return;
      // Only our fixed validation messages are safe to print; SDK errors may contain the token.
      console.warn(error instanceof GrammyError ? `Telegram startup failed (API ${error.error_code}); RN remains available.`
        : error instanceof Error && error.message.startsWith("Telegram has a webhook") ? error.message : "Telegram startup failed; RN remains available.");
    });
  }

  private async initialize(): Promise<void> {
    const signal = this.pollingController.signal as unknown as typeof this.api.signal;
    await this.bot.init(signal);
    if (this.stopping) return;
    const webhook = await this.bot.api.getWebhookInfo(signal);
    if (webhook.url) throw new Error("Telegram has a webhook; remove it explicitly before enabling long polling. RN remains available.");
    await this.bot.api.setMyCommands(TELEGRAM_COMMANDS, {}, signal);
    if (this.stopping) return;
    this.channel = new TelegramChannel({ botId: String(this.bot.botInfo.id), username: this.bot.botInfo.username!, userId: this.config.userId },
      this.conversations, this.runtime, this.api);
    console.log("Piko Telegram private-chat channel started.");
    this.polling = this.poll().catch(error => {
      this.channel?.stopAccepting();
      if (!this.stopping) console.warn(`Piko Telegram polling/admission stopped (${telegramErrorCode(error)}); RN remains available.`);
    });
  }

  private async poll(): Promise<void> {
    let offset = 0;
    const signal = this.pollingController.signal as unknown as typeof this.api.signal;
    // Own only the poll cursor: grammY's Bot.stop confirms the last attempted update and
    // Bot.start deletes webhooks. Neither is suitable for durable admission failures.
    while (!this.stopping) {
      const updates = await telegramRequest(() => this.bot.api.getUpdates({ offset, timeout: 5,
        allowed_updates: ["message"] }, signal), this.pollingController.signal);
      for (const update of updates) {
        if (this.stopping) return;
        await this.bot.handleUpdate(update);
        // Confirmation happens on the next fetch, strictly after successful admission.
        offset = update.update_id + 1;
      }
    }
  }

  async stopInput(): Promise<void> {
    this.stopping = true;
    this.channel?.stopAccepting();
    this.pollingController.abort();
    await this.starting;
    await this.polling;
  }

  async close(): Promise<void> {
    await this.channel?.drain();
    this.api.controller.abort();
  }
}
