import type { RuntimeDescription } from "../../../shared/runtime";
import type { ConversationStore } from "../../chat/conversations";
import { RuntimeBusyError, type ChatRuntime } from "../../runtime/types";
import type { TelegramKeyboard, TelegramTransport } from "./api";
import { sameModel, selectionText } from "./command-format";
import { TELEGRAM_BUTTON_LABEL_LIMIT, TELEGRAM_MENU_PAGE_SIZE } from "./menu-policy";
import { singleLine } from "../../runtime/text";

type Address = { chatId: string; messageId: string };
export type TelegramCallback = Address & {
  callbackId: string; actorId: string; chatType: string; data: string; topic?: boolean; business?: boolean;
};
type Menu = Address & {
  token: string; createdAt: number; working: boolean; actions: Set<string>;
  description: RuntimeDescription; kind: "models" | "thinking";
};
export class TelegramMenuError extends Error {}
const rows = (buttons: TelegramKeyboard[number], columns: number): TelegramKeyboard =>
  Array.from({ length: Math.ceil(buttons.length / columns) }, (_, i) => buttons.slice(i * columns, (i + 1) * columns));
type View = { text: string; buttons: TelegramKeyboard };

/** Ephemeral, source-bound menus. Issued indices keep referring to the same catalog snapshot. */
export class TelegramMenus {
  private readonly menus = new Map<string, Menu>();
  constructor(private readonly store: ConversationStore, private readonly runtime: ChatRuntime, private readonly api: TelegramTransport) {}

  async open(address: Address, kind: Menu["kind"], description?: RuntimeDescription): Promise<void> {
    description ??= await this.runtime.describe();
    description = { ...description, models: [...description.models].sort((a, b) =>
      a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) };
    const menu: Menu = { ...address, token: crypto.randomUUID().slice(0, 12), createdAt: Date.now(), working: false,
      actions: new Set(), description, kind };
    const view = this.view(menu);
    menu.messageId = await this.api.send(address.chatId, view.text, false, view.buttons);
    menu.actions = new Set(view.buttons.flat().map(button => button.callbackData));
    this.menus.set(menu.token, menu); this.prune();
  }
  private prune(): void {
    for (const [token, menu] of this.menus) if (Date.now() - menu.createdAt > 15 * 60_000) this.menus.delete(token);
    while (this.menus.size > 64) this.menus.delete(this.menus.keys().next().value!);
  }
  private view(menu: Menu, provider?: string, requestedPage = 0, providersPage = 0): View {
    const data = (action: string) => `p:${menu.token}:${action}`;
    const { description } = menu;
    let text: string, buttons: TelegramKeyboard;
    if (menu.kind === "thinking") {
      const selected = description.selection;
      const model = description.models.find(item => item.provider === selected?.provider && item.id === selected?.model);
      text = `${selectionText(description)}\n\nChoose thinking level:`;
      const levels = model?.thinkingLevels ?? [];
      buttons = levels.length <= 1 ? [] : rows(levels.map((level, index) => ({
        text: `${level}${level === (selected?.thinking ?? "off") ? " ✓" : ""}`, callbackData: data(`think:${index}`),
      })), 3);
      if (!model) text = `${selectionText(description)}\n\nChoose a model with /models first.`;
      else if (levels.length <= 1) text = `${selectionText(description)}\n\nCurrent model does not support adjustable thinking levels.`;
    } else if (provider !== undefined) {
      const providers = [...new Set(description.models.map(model => model.provider))].sort();
      const providerIndex = providers.indexOf(provider);
      const models = description.models.flatMap((model, index) => model.provider !== provider ? [] : [{ model, index }]);
      const pages = Math.max(1, Math.ceil(models.length / TELEGRAM_MENU_PAGE_SIZE));
      const page = Math.min(Math.max(requestedPage, 0), pages - 1);
      const visible = models.slice(page * TELEGRAM_MENU_PAGE_SIZE, (page + 1) * TELEGRAM_MENU_PAGE_SIZE);
      text = `${selectionText(description)}\n\nChoose a model from ${singleLine(provider, TELEGRAM_BUTTON_LABEL_LIMIT) ?? provider}:${pages > 1 ? `\nPage ${page + 1}/${pages}` : ""}`;
      buttons = rows(visible.map(({ model, index }) => ({
        text: singleLine(`${model.name}${sameModel(description.selection, { provider: model.provider, model: model.id }) ? " ✓" : ""}`, TELEGRAM_BUTTON_LABEL_LIMIT) ?? "Model",
        callbackData: data(`model:${index}:${page.toString(36)}:${providersPage.toString(36)}`),
      })), 2);
      if (pages > 1) {
        const navigation: TelegramKeyboard[number] = [];
        if (page > 0) navigation.push({ text: "‹ Previous", callbackData: data(`models:${providerIndex}:${(page - 1).toString(36)}:${providersPage.toString(36)}`) });
        if (page < pages - 1) navigation.push({ text: "Next ›", callbackData: data(`models:${providerIndex}:${(page + 1).toString(36)}:${providersPage.toString(36)}`) });
        buttons.push(navigation);
      }
      buttons.push([{ text: "Back to providers", callbackData: data(`providers:${providersPage.toString(36)}`) }]);
    } else {
      const providers = [...new Set(description.models.map(model => model.provider))].sort();
      const pages = Math.max(1, Math.ceil(providers.length / TELEGRAM_MENU_PAGE_SIZE));
      const page = Math.min(Math.max(requestedPage, 0), pages - 1);
      const visible = providers.slice(page * TELEGRAM_MENU_PAGE_SIZE, (page + 1) * TELEGRAM_MENU_PAGE_SIZE);
      text = `${selectionText(description)}\n\nChoose a provider:${pages > 1 ? `\nPage ${page + 1}/${pages}` : ""}`;
      buttons = rows(visible.map((name, offset) => {
        const index = page * TELEGRAM_MENU_PAGE_SIZE + offset;
        const count = description.models.filter(model => model.provider === name).length;
        return {
          text: singleLine(`${name} (${count})`, TELEGRAM_BUTTON_LABEL_LIMIT) ?? "Provider",
          callbackData: data(`provider:${index}:${page.toString(36)}`),
        };
      }), 2);
      if (pages > 1) {
        const navigation: TelegramKeyboard[number] = [];
        if (page > 0) navigation.push({ text: "‹ Previous", callbackData: data(`providers:${(page - 1).toString(36)}`) });
        if (page < pages - 1) navigation.push({ text: "Next ›", callbackData: data(`providers:${(page + 1).toString(36)}`) });
        buttons.push(navigation);
      }
      if (!providers.length) text = "No available models. Check your model configuration and credentials, then restart Piko.";
    }
    return { text, buttons };
  }
  private async edit(menu: Menu, view: View) {
    await this.api.edit(menu.chatId, menu.messageId, view.text, false, view.buttons);
    // A failed edit leaves the old keyboard usable, not a set of actions the user never saw.
    menu.actions = new Set(view.buttons.flat().map(button => button.callbackData));
  }
  async handle(callback: TelegramCallback): Promise<void> {
    this.prune();
    const match = /^p:([\da-f-]{12}):(home|providers:[0-9a-z]+|provider:\d+:[0-9a-z]+|models:\d+:[0-9a-z]+:[0-9a-z]+|model:\d+:[0-9a-z]+:[0-9a-z]+|think:\d+)$/.exec(callback.data);
    const menu = match && this.menus.get(match[1]);
    if (!menu || menu.chatId !== callback.chatId || menu.messageId !== callback.messageId || !menu.actions.has(callback.data)) {
      await this.api.answerCallback(callback.callbackId, `Menu expired. Reopen ${menu?.kind === "thinking" ? "/thinking" : menu ? "/models" : "the command"}.`, false); return;
    }
    if (menu.working) { await this.api.answerCallback(callback.callbackId, "One moment…"); return; }
    menu.working = true;
    let applied = false;
    const action = match![2];
    const setting = action.startsWith("think:") ? "thinking" : "model";
    try {
      if (action === "home" || action.startsWith("provider:") || action.startsWith("providers:") || action.startsWith("models:")) {
        await this.api.answerCallback(callback.callbackId);
        // Refresh the current selection, but never reorder or replace an issued menu's indices.
        const current = await this.runtime.describe();
        menu.description = { ...menu.description, selection: current.selection };
        const parts = action.split(":");
        const providers = [...new Set(menu.description.models.map(model => model.provider))].sort();
        if (parts[0] === "provider") {
          const provider = providers[Number(parts[1])];
          if (!provider) throw new TelegramMenuError("Provider unavailable. Reopen /models.");
          await this.edit(menu, this.view(menu, provider, 0, Number.parseInt(parts[2]!, 36)));
        } else if (parts[0] === "providers") {
          await this.edit(menu, this.view(menu, undefined, Number.parseInt(parts[1]!, 36)));
        } else if (parts[0] === "models") {
          const provider = providers[Number(parts[1])];
          if (!provider) throw new TelegramMenuError("Provider unavailable. Reopen /models.");
          await this.edit(menu, this.view(menu, provider, Number.parseInt(parts[2]!, 36), Number.parseInt(parts[3]!, 36)));
        } else {
          await this.edit(menu, this.view(menu));
        }
        return;
      }
      const parts = action.split(":");
      const index = Number(parts[1]);
      const providersPage = parts[0] === "model" ? Number.parseInt(parts[3]!, 36) : 0;
      const description = await this.store.changeRuntime(async () => {
        const current = await this.runtime.describe();
        if (setting === "model") {
          const target = menu.description.models[index];
          const model = current.models.find(model => model.provider === target.provider && model.id === target.id);
          if (!model) throw new TelegramMenuError("Model unavailable. Reopen /models.");
          await this.runtime.configure({ provider: model.provider, model: model.id });
        } else {
          if (!sameModel(current.selection, menu.description.selection)) throw new TelegramMenuError("Model changed. Reopen /thinking.");
          const selected = menu.description.selection!;
          const model = menu.description.models.find(model => model.provider === selected.provider && model.id === selected.model)!;
          const thinking = model.thinkingLevels[index];
          if (!current.models.find(model => sameModel({ provider: model.provider, model: model.id }, selected))?.thinkingLevels.includes(thinking))
            throw new TelegramMenuError("Thinking level unavailable. Reopen /thinking.");
          await this.runtime.configure({ thinking });
        }
        applied = true;
        return this.runtime.describe();
      });
      menu.description = { ...menu.description, selection: description.selection };
      if (menu.kind === "thinking") {
        await this.edit(menu, this.view(menu));
        await this.api.answerCallback(callback.callbackId, `Thinking set to ${description.selection?.thinking ?? "off"}`);
      } else {
        const selected = description.selection!;
        const model = description.models.find(model => sameModel({ provider: model.provider, model: model.id }, selected));
        const adjustable = (model?.thinkingLevels.length ?? 0) > 1;
        await this.edit(menu, { text: `Selected model:\n${selectionText(description)}${adjustable ? "\n\nUse /thinking to adjust its thinking level." : ""}`,
          buttons: [[{ text: "Back to providers", callbackData: `p:${menu.token}:providers:${providersPage.toString(36)}` }]] });
        await this.api.answerCallback(callback.callbackId, `Model set to ${model?.name ?? selected.model}`);
        // Keep model navigation available while offering the actual supported, clamped thinking level.
        if (adjustable) await this.open(callback, "thinking", description);
      }
    } catch (error) {
      if (error instanceof TelegramMenuError) throw error;
      if (error instanceof RuntimeBusyError) throw new TelegramMenuError("Piko is busy. Try again later.");
      if (applied) throw new TelegramMenuError("Updated. Check /status if needed.");
      // A transport/storage failure is not proof that nothing was persisted. Do not promise rollback.
      throw new TelegramMenuError(action === "home" || action.startsWith("provider:")
        ? "Couldn't refresh. Reopen /models."
        : "Couldn't confirm. Check /status.");
    } finally { menu.working = false; }
  }
}
