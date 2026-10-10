import type { ModelSelection, RuntimeDescription } from "../../../shared/runtime";
import { RuntimeBusyError, type ConversationStore } from "../../chat/conversations";
import type { ChatRuntime } from "../../runtime/types";
import type { TelegramKeyboard, TelegramTransport } from "./api";

type Address = { chatId: string; messageId: string };
export type TelegramCallback = Address & {
  callbackId: string; actorId: string; chatType: string; data: string; topic?: boolean; business?: boolean;
};
type Menu = Address & {
  token: string; createdAt: number; working: boolean; actions: Set<string>;
  description: RuntimeDescription; kind: "models" | "thinking";
};
export class TelegramMenuError extends Error {
  constructor(error: unknown) {
    super(error instanceof RuntimeBusyError ? "Piko is busy. Try again when it's ready."
      : "Couldn't update this setting. Reopen /models or /thinking and try again.");
  }
}
const rows = (buttons: TelegramKeyboard[number], columns: number): TelegramKeyboard =>
  Array.from({ length: Math.ceil(buttons.length / columns) }, (_, i) => buttons.slice(i * columns, (i + 1) * columns));
const sameModel = (a?: ModelSelection, b?: ModelSelection) => !!a && !!b && a.provider === b.provider && a.model === b.model;
export function selectionText(description: RuntimeDescription): string {
  const selection = description.selection;
  if (!selection) return "Model: Not set\nThinking: Not set";
  const model = description.models.find(item => item.provider === selection.provider && item.id === selection.model);
  return `Model: ${selection.provider}/${selection.model}\nThinking: ${selection.thinking ?? "off"}` +
    (model?.contextWindow ? `\nContext limit: ${model.contextWindow.toLocaleString("en-US")} tokens` : "");
}

/** Ephemeral, source-bound menus. Indices refer to this menu's snapshot, never a reordered catalog. */
export class TelegramMenus {
  private readonly menus = new Map<string, Menu>();
  constructor(private readonly store: ConversationStore, private readonly runtime: ChatRuntime, private readonly api: TelegramTransport) {}

  async open(address: Address, kind: Menu["kind"], description?: RuntimeDescription): Promise<void> {
    description ??= await this.runtime.describe!(this.store.context());
    description = { ...description, models: [...description.models].sort((a, b) =>
      a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) };
    const menu: Menu = { ...address, token: crypto.randomUUID().slice(0, 12), createdAt: Date.now(), working: false,
      actions: new Set(), description, kind };
    const view = this.view(menu);
    menu.messageId = await this.api.send(address.chatId, view.text, false, view.buttons);
    this.menus.set(menu.token, menu);
    this.prune();
  }

  invalidate(): void { this.menus.clear(); }

  private prune(): void {
    for (const [token, menu] of this.menus) if (Date.now() - menu.createdAt > 15 * 60_000) this.menus.delete(token);
    while (this.menus.size > 64) this.menus.delete(this.menus.keys().next().value!);
  }

  private view(menu: Menu, provider?: string): { text: string; buttons: TelegramKeyboard } {
    const data = (action: string) => `p:${menu.token}:${action}`;
    const { description } = menu;
    let text: string, buttons: TelegramKeyboard;
    if (menu.kind === "thinking") {
      const selected = description.selection;
      const model = description.models.find(item => item.provider === selected?.provider && item.id === selected?.model);
      text = `Choose a thinking level\n${selectionText(description)}`;
      buttons = rows((model?.thinkingLevels ?? []).map((level, index) => ({
        text: `${level}${level === (selected?.thinking ?? "off") ? " ✓" : ""}`, callbackData: data(`think:${index}`),
      })), 3);
      if (!model) text += "\nChoose a model with /models first.";
      else if (model.thinkingLevels.length === 1 && model.thinkingLevels[0] === "off") text += "\nThinking is unavailable for this model.";
    } else if (provider !== undefined) {
      text = `${provider} models\n${selectionText(description)}`;
      buttons = rows(description.models.flatMap((model, index) => model.provider !== provider ? [] : [{
        text: `${model.name}${sameModel(description.selection, { provider: model.provider, model: model.id }) ? " ✓" : ""}`,
        callbackData: data(`model:${index}`),
      }]), 2);
      buttons.push([{ text: "Back to providers", callbackData: data("home") }]);
    } else {
      const providers = [...new Set(description.models.map(model => model.provider))].sort();
      text = `Choose a provider\n${selectionText(description)}`;
      buttons = rows(providers.map((name, index) => ({
        text: `${name} (${description.models.filter(model => model.provider === name).length})`, callbackData: data(`provider:${index}`),
      })), 2);
      if (!providers.length) text += "\nNo models available. Add your model credentials, then use /reload.";
    }
    menu.actions = new Set(buttons.flat().map(button => button.callbackData));
    return { text, buttons };
  }

  async handle(callback: TelegramCallback): Promise<void> {
    this.prune();
    const match = /^p:([\da-f-]{12}):(home|provider:\d+|model:\d+|think:\d+)$/.exec(callback.data);
    const menu = match && this.menus.get(match[1]);
    if (!menu || menu.chatId !== callback.chatId || menu.messageId !== callback.messageId || !menu.actions.has(callback.data)) {
      await this.api.answerCallback(callback.callbackId, "This menu has expired. Reopen /models or /thinking.", true); return;
    }
    if (menu.working) { await this.api.answerCallback(callback.callbackId, "One moment…"); return; }
    menu.working = true;
    try {
      const action = match![2];
      if (action === "home" || action.startsWith("provider:")) {
        await this.api.answerCallback(callback.callbackId);
        const provider = action === "home" ? undefined : [...new Set(menu.description.models.map(model => model.provider))].sort()[Number(action.split(":")[1])];
        const view = this.view(menu, provider);
        await this.api.edit(menu.chatId, menu.messageId, view.text, false, view.buttons);
        return;
      }
      const index = Number(action.split(":")[1]);
      const description = await this.store.changeRuntime(async () => {
        const current = await this.runtime.describe!(this.store.context());
        if (action.startsWith("model:")) {
          const target = menu.description.models[index];
          const model = current.models.find(model => model.provider === target.provider && model.id === target.id);
          if (!model) throw new Error("Model no longer available.");
          await this.runtime.configure!(this.store.context(), { provider: model.provider, model: model.id });
        } else {
          if (!sameModel(current.selection, menu.description.selection)) throw new Error("Model has changed.");
          const selected = menu.description.selection!;
          const model = menu.description.models.find(model => model.provider === selected.provider && model.id === selected.model)!;
          const thinking = model.thinkingLevels[index];
          if (!current.models.find(model => sameModel({ provider: model.provider, model: model.id }, selected))?.thinkingLevels.includes(thinking)) throw new Error("Thinking level no longer available.");
          await this.runtime.configure!(this.store.context(), { thinking });
        }
        return this.runtime.describe!(this.store.context());
      }).catch(error => { throw new TelegramMenuError(error); });
      // Keep issued indices stable for this menu's lifetime, including after returning home.
      menu.description = { ...menu.description, selection: description.selection };
      await this.api.answerCallback(callback.callbackId, action.startsWith("model:") ? "Model updated" : "Thinking level updated");
      if (menu.kind === "thinking") {
        const view = this.view(menu);
        await this.api.edit(menu.chatId, menu.messageId, view.text, false, view.buttons);
      } else {
        const buttons = [[{ text: "Back to providers", callbackData: `p:${menu.token}:home` }]];
        menu.actions = new Set(buttons.flat().map(button => button.callbackData));
        await this.api.edit(menu.chatId, menu.messageId, `Model updated\n${selectionText(description)}`, false, buttons);
        const selected = description.selection!;
        const model = description.models.find(model => sameModel({ provider: model.provider, model: model.id }, selected));
        if ((model?.thinkingLevels.length ?? 0) > 1) await this.open(callback, "thinking", description);
      }
    } finally { menu.working = false; }
  }
}
