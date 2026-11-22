import type { InputRichBlock } from "grammy/types";
import type { PostSummary } from "../../../shared/posts";
import type { PostsRuntime } from "../../runtime/types";
import { singleLine, truncateUtf16Text } from "../../runtime/text";
import type { TelegramCallback } from "./menus";
import type { TelegramKeyboard, TelegramTransport } from "./api";
import { TELEGRAM_BUTTON_LABEL_LIMIT, TELEGRAM_MENU_PAGE_SIZE } from "./menu-policy";
import { editRichMenu, editTelegramRich, escapeTelegramMarkdown, menuInlineButton, menuNavigation, sendRichMenu, sendTelegramRich, splitTelegramRichText, type RichMenuView } from "./rich-text";

type Address = { chatId: string; messageId: string };
type View = RichMenuView & { buttons: TelegramKeyboard; actions: Set<string> };
type Menu = Address & {
  token: string;
  createdAt: number;
  working: boolean;
  page: number;
  cursors: (string | undefined)[];
  posts: PostSummary[];
  nextBefore?: string;
  actions: Set<string>;
  extraMessageIds: string[];
};

function callbackData(token: string, action: string) {
  const value = `o:${token}:${action}`;
  if (new TextEncoder().encode(value).byteLength > 64) throw new Error("Post callback is too long.");
  return value;
}

/** Telegram's current Post browser is an ephemeral, source-bound list/detail menu. */
export class TelegramPostMenus {
  private readonly menus = new Map<string, Menu>();
  private readonly working = new Set<string>();

  constructor(private readonly getPosts: () => Promise<Pick<PostsRuntime, "list" | "read">>, private readonly api: TelegramTransport) {}

  private prune() {
    for (const [token, menu] of this.menus)
      if (Date.now() - menu.createdAt > 15 * 60_000) this.menus.delete(token);
    while (this.menus.size > 64) this.menus.delete(this.menus.keys().next().value!);
  }

  private async listView(menu: Menu): Promise<View> {
    const page = await (await this.getPosts()).list(menu.cursors[menu.page], TELEGRAM_MENU_PAGE_SIZE);
    menu.posts = page.posts;
    menu.nextBefore = page.nextBefore;
    const data = (action: string) => callbackData(menu.token, action);
    const buttons: TelegramKeyboard = page.posts.map((post, index) => [{
      text: truncateUtf16Text(`${index + 1}. ${singleLine(post.title, TELEGRAM_BUTTON_LABEL_LIMIT) ?? "Untitled"}`, TELEGRAM_BUTTON_LABEL_LIMIT),
      callbackData: data(`read:${post.id}`),
    }]);
    const navigation: TelegramKeyboard[number] = [];
    if (menu.page > 0) navigation.push({ text: "‹ Previous", callbackData: data("previous") });
    if (page.nextBefore) navigation.push({ text: "Next ›", callbackData: data("next") });
    if (navigation.length) buttons.push(navigation);
    const text = page.posts.length
      ? [`**Posts · Page ${menu.page + 1}**`, "", ...page.posts.map((post, index) =>
          `${index + 1}. ${escapeTelegramMarkdown(singleLine(post.title, TELEGRAM_BUTTON_LABEL_LIMIT) ?? "Untitled")}`), "", "Select a title below."].join("\n")
      : `**Posts**\n\n${menu.page === 0 ? "No posts yet." : "No more posts on this page."}`;
    const blocks: InputRichBlock[] = [{ type: "paragraph", text: `Posts · Page ${menu.page + 1}` }];
    for (const post of page.posts) {
      const title = singleLine(post.title, TELEGRAM_BUTTON_LABEL_LIMIT) ?? "Untitled";
      blocks.push({ type: "paragraph", text: [title + "  ", menuInlineButton("Read", data(`read:${post.id}`))] });
    }
    if (!page.posts.length) blocks.push({ type: "paragraph", text: menu.page === 0 ? "No posts yet." : "No more posts on this page." });
    if (navigation.length) blocks.push(menuNavigation(navigation));
    return { text, buttons, actions: new Set(buttons.flat().map(button => button.callbackData)), rich: { blocks } };
  }

  async open(address: Address): Promise<void> {
    this.prune();
    const menu: Menu = {
      ...address, token: crypto.randomUUID().slice(0, 12), createdAt: Date.now(), working: false,
      page: 0, cursors: [undefined], posts: [], actions: new Set(), extraMessageIds: [],
    };
    const view = await this.listView(menu);
    menu.messageId = await sendRichMenu(this.api, address.chatId, view, true);
    menu.actions = view.actions;
    this.menus.set(menu.token, menu);
    this.prune();
  }

  private async removeContinuationMessages(menu: Menu) {
    const ids = menu.extraMessageIds.splice(0);
    await Promise.all(ids.map(id => this.api.remove(menu.chatId, id).catch(() => {})));
  }

  private async editList(menu: Menu) {
    await this.removeContinuationMessages(menu);
    const view = await this.listView(menu);
    await editRichMenu(this.api, menu.chatId, menu.messageId, view, true);
    menu.actions = view.actions;
  }

  private async editDetail(menu: Menu, postId: string) {
    await this.removeContinuationMessages(menu);
    const post = await (await this.getPosts()).read(postId);
    const chunks = splitTelegramRichText(`**${escapeTelegramMarkdown(post.title)}**\n\n${post.body}`);
    const back = callbackData(menu.token, "back");
    const buttons: TelegramKeyboard = [[{ text: "‹ Back to posts", callbackData: back }]];
    await editTelegramRich(this.api, menu.chatId, menu.messageId, chunks[0]!, buttons);
    menu.actions = new Set([back]);
    try {
      for (const chunk of chunks.slice(1)) {
        menu.extraMessageIds.push(await sendTelegramRich(this.api, menu.chatId, chunk));
      }
    } catch (error) {
      await this.removeContinuationMessages(menu);
      await this.editList(menu);
      throw error;
    }
  }

  async handle(callback: TelegramCallback): Promise<void> {
    this.prune();
    const match = /^o:([\da-f-]{12}):(previous|next|back|read:([1-9]\d*))$/.exec(callback.data);
    const menu = match && this.menus.get(match[1]!);
    if (!menu || menu.chatId !== callback.chatId || menu.messageId !== callback.messageId || !menu.actions.has(callback.data)) {
      await this.api.answerCallback(callback.callbackId, "Menu expired. Reopen /posts.", false);
      return;
    }
    const messageKey = `${callback.chatId}:${callback.messageId}`;
    if (menu.working || this.working.has(messageKey)) {
      await this.api.answerCallback(callback.callbackId, "One moment…");
      return;
    }
    menu.working = true;
    this.working.add(messageKey);
    try {
      const action = match![2]!;
      if (action === "previous") {
        menu.page--;
        await this.editList(menu);
      } else if (action === "next") {
        if (!menu.nextBefore) throw new Error("No next page.");
        menu.cursors[menu.page + 1] = menu.nextBefore;
        menu.cursors.length = menu.page + 2;
        menu.page++;
        await this.editList(menu);
      } else if (action === "back") {
        await this.editList(menu);
      } else {
        await this.editDetail(menu, match![3]!);
      }
      await this.api.answerCallback(callback.callbackId);
    } catch {
      await this.api.answerCallback(callback.callbackId, "Couldn't load posts. Reopen /posts and try again.", false);
    } finally {
      menu.working = false;
      this.working.delete(messageKey);
    }
  }
}
