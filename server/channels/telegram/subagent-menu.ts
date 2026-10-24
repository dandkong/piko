import type { ChatRuntime, SubagentDetail, SubagentListItem } from "../../runtime/types";
import { singleLine } from "../../runtime/tool-activity";
import type { TelegramCallback } from "./menus";
import type { TelegramKeyboard, TelegramTransport } from "./api";

type Address = { chatId: string; messageId: string };
type Menu = Address & {
  token: string;
  createdAt: number;
  working: boolean;
  actions: Set<string>;
  items: SubagentListItem[];
  page: number;
};
type View = { text: string; buttons?: TelegramKeyboard };

const PAGE_SIZE = 8;
const MENU_TTL_MS = 15 * 60_000;
const MAX_MENUS = 64;

function statusIcon(status: SubagentListItem["status"]): string {
  switch (status) {
    case "working": return "🔄";
    case "finished": return "✅";
    case "failed": return "❌";
    case "stopped": return "⏹️";
    case "interrupted": return "⚠️";
  }
}

function newestFirst(items: SubagentListItem[]): SubagentListItem[] {
  return [...items].sort((a, b) => {
    const left = BigInt(a.id);
    const right = BigInt(b.id);
    return left > right ? -1 : left < right ? 1 : 0;
  });
}

export class TelegramSubagentMenus {
  private readonly menus = new Map<string, Menu>();

  constructor(private readonly runtime: Pick<ChatRuntime, "subagents">, private readonly api: TelegramTransport) {}

  async open(address: Address): Promise<void> {
    const items = this.activeOnly(await this.runtime.subagents().then(service => service.list()));
    if (!items.length) {
      await this.api.send(address.chatId, "Active subagents\nNo subagents are currently working.", false);
      return;
    }
    const menu: Menu = {
      ...address,
      token: crypto.randomUUID().slice(0, 12),
      createdAt: Date.now(),
      working: false,
      actions: new Set(),
      items,
      page: 0,
    };
    const view = this.listView(menu);
    menu.messageId = await this.api.send(address.chatId, view.text, false, view.buttons);
    menu.actions = new Set(view.buttons?.flat().map(button => button.callbackData) ?? []);
    this.menus.set(menu.token, menu);
    this.prune();
  }

  private activeOnly(items: SubagentListItem[]): SubagentListItem[] {
    return newestFirst(items).filter(item => item.status === "working");
  }

  private prune(): void {
    for (const [token, menu] of this.menus)
      if (Date.now() - menu.createdAt > MENU_TTL_MS) this.menus.delete(token);
    while (this.menus.size > MAX_MENUS) this.menus.delete(this.menus.keys().next().value!);
  }

  private data(menu: Menu, action: string): string {
    return `s:${menu.token}:${action}`;
  }

  private listView(menu: Menu): View {
    const pages = Math.max(1, Math.ceil(menu.items.length / PAGE_SIZE));
    menu.page = Math.min(Math.max(menu.page, 0), pages - 1);
    const start = menu.page * PAGE_SIZE;
    const items = menu.items.slice(start, start + PAGE_SIZE);
    const lines = [
      `Active subagents (${menu.items.length})`,
      "Choose a job ID to view its latest status and five recent steps:",
      "",
      ...items.map(item =>
        `${statusIcon(item.status)} #${item.id} · ${singleLine(item.task, 100) ?? "(no task description)"}`,
      ),
    ];
    const buttons: TelegramKeyboard = [items.map(item => ({
      text: `#${item.id}`, 
      callbackData: this.data(menu, `detail:${item.id}`),
    }))];
    if (pages > 1) {
      const navigation: TelegramKeyboard[number] = [];
      if (menu.page > 0) navigation.push({ text: "‹ Previous", callbackData: this.data(menu, `page:${menu.page - 1}`) });
      if (menu.page < pages - 1) navigation.push({ text: "Next ›", callbackData: this.data(menu, `page:${menu.page + 1}`) });
      buttons.push(navigation);
    }
    return { text: lines.join("\n"), buttons };
  }

  private detailView(menu: Menu, item: SubagentListItem, detail: SubagentDetail): View {
    return {
      text: [
        `Background subagent #${detail.id}`,
        `Task: ${singleLine(item.task, 160) ?? "(no task description)"}`,
        `Status: ${detail.status}`,
        ...(detail.detail ? [`Detail: ${singleLine(detail.detail, 160)}`] : []),
        "",
        "Recent steps:",
        ...(detail.recentSteps.length ? detail.recentSteps.map(step => `• ${step}`) : ["(none yet)"]),
      ].join("\n"),
      buttons: [[{ text: "Back to list", callbackData: this.data(menu, "back") }]],
    };
  }

  async handle(callback: TelegramCallback): Promise<void> {
    this.prune();
    const match = /^s:([\da-f-]{12}):(back|page:\d+|detail:\d+)$/.exec(callback.data);
    const menu = match && this.menus.get(match[1]);
    if (!menu || menu.chatId !== callback.chatId || menu.messageId !== callback.messageId || !menu.actions.has(callback.data)) {
      await this.api.answerCallback(callback.callbackId, "This menu has expired. Reopen /subagent.", true);
      return;
    }
    if (menu.working) {
      await this.api.answerCallback(callback.callbackId, "One moment…");
      return;
    }
    menu.working = true;
    try {
      const action = match![2];
      if (action === "back" || action.startsWith("page:")) {
        const page = action === "back" ? 0 : Number(action.slice("page:".length));
        const items = action === "back"
          ? this.activeOnly(await this.runtime.subagents().then(service => service.list()))
          : menu.items;
        const previousItems = menu.items;
        const previousPage = menu.page;
        menu.items = items;
        menu.page = page;
        const view = this.listView(menu);
        try {
          await this.api.edit(menu.chatId, menu.messageId, view.text, false, view.buttons);
          menu.actions = new Set(view.buttons?.flat().map(button => button.callbackData) ?? []);
        } catch (error) {
          menu.items = previousItems;
          menu.page = previousPage;
          throw error;
        }
      } else {
        const id = action.slice("detail:".length);
        const item = menu.items.find(value => value.id === id);
        const detail = await this.runtime.subagents().then(service => service.status(id));
        if (!item || !detail) {
          await this.api.answerCallback(callback.callbackId, "This subagent is no longer available. Reopen /subagent.", true);
          return;
        }
        const view = this.detailView(menu, item, detail);
        await this.api.edit(menu.chatId, menu.messageId, view.text, false, view.buttons);
        menu.actions = new Set(view.buttons?.flat().map(button => button.callbackData) ?? []);
      }
      await this.api.answerCallback(callback.callbackId);
    } catch {
      await this.api.answerCallback(callback.callbackId, "Couldn't refresh /subagent. Reopen the command and try again.", true);
    } finally {
      menu.working = false;
    }
  }
}

