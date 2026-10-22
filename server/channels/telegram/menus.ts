import type { RuntimeDescription } from "../../../shared/runtime";
import type { ConversationStore } from "../../chat/conversations";
import { RuntimeBusyError, type ChatRuntime } from "../../runtime/types";
import type { TelegramKeyboard, TelegramTransport } from "./api";
import { busyMessage, sameModel, selectionText } from "./command-format";

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
  private view(menu: Menu, provider?: string): View {
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
      text = `${selectionText(description)}\n\nChoose a model from ${provider}:`;
      buttons = rows(description.models.flatMap((model, index) => model.provider !== provider ? [] : [{
        text: `${model.name}${sameModel(description.selection, { provider: model.provider, model: model.id }) ? " ✓" : ""}`,
        callbackData: data(`model:${index}`),
      }]), 2);
      buttons.push([{ text: "Back to providers", callbackData: data("home") }]);
    } else {
      const providers = [...new Set(description.models.map(model => model.provider))].sort();
      text = `${selectionText(description)}\n\nChoose a provider:`;
      buttons = rows(providers.map((name, index) => ({
        text: `${name} (${description.models.filter(model => model.provider === name).length})`, callbackData: data(`provider:${index}`),
      })), 2);
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
    const match = /^p:([\da-f-]{12}):(home|provider:\d+|model:\d+|think:\d+)$/.exec(callback.data);
    const menu = match && this.menus.get(match[1]);
    if (!menu || menu.chatId !== callback.chatId || menu.messageId !== callback.messageId || !menu.actions.has(callback.data)) {
      await this.api.answerCallback(callback.callbackId, `This menu has expired. Reopen ${menu?.kind === "thinking" ? "/thinking" : menu ? "/models" : "/models or /thinking"}.`, true); return;
    }
    if (menu.working) { await this.api.answerCallback(callback.callbackId, "One moment…"); return; }
    menu.working = true;
    let applied = false;
    const action = match![2];
    const setting = action.startsWith("think:") ? "thinking" : "model";
    try {
      if (action === "home" || action.startsWith("provider:")) {
        await this.api.answerCallback(callback.callbackId);
        // Refresh the current selection, but never reorder or replace an issued menu's indices.
        const current = await this.runtime.describe();
        menu.description = { ...menu.description, selection: current.selection };
        const provider = action === "home" ? undefined : [...new Set(menu.description.models.map(model => model.provider))].sort()[Number(action.split(":")[1])];
        await this.edit(menu, this.view(menu, provider)); return;
      }
      const index = Number(action.split(":")[1]);
      const description = await this.store.changeRuntime(async () => {
        const current = await this.runtime.describe();
        if (setting === "model") {
          const target = menu.description.models[index];
          const model = current.models.find(model => model.provider === target.provider && model.id === target.id);
          if (!model) throw new TelegramMenuError("This model is no longer available. Reopen /models to choose another.");
          await this.runtime.configure({ provider: model.provider, model: model.id });
        } else {
          if (!sameModel(current.selection, menu.description.selection)) throw new TelegramMenuError("The current model has changed. Reopen /thinking to see its supported levels.");
          const selected = menu.description.selection!;
          const model = menu.description.models.find(model => model.provider === selected.provider && model.id === selected.model)!;
          const thinking = model.thinkingLevels[index];
          if (!current.models.find(model => sameModel({ provider: model.provider, model: model.id }, selected))?.thinkingLevels.includes(thinking))
            throw new TelegramMenuError("This thinking level is no longer available. Reopen /thinking to choose again.");
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
          buttons: [[{ text: "Back to providers", callbackData: `p:${menu.token}:home` }]] });
        await this.api.answerCallback(callback.callbackId, `Model set to ${model?.name ?? selected.model}`);
        // Keep model navigation available while offering the actual supported, clamped thinking level.
        if (adjustable) await this.open(callback, "thinking", description);
      }
    } catch (error) {
      if (error instanceof TelegramMenuError) throw error;
      if (error instanceof RuntimeBusyError) throw new TelegramMenuError(busyMessage(setting));
      if (applied) throw new TelegramMenuError(`${setting === "model" ? "Model" : "Thinking level"} updated, but the menu could not refresh. Use /status to check it, then reopen /${menu.kind}.`);
      // A transport/storage failure is not proof that nothing was persisted. Do not promise rollback.
      throw new TelegramMenuError(action === "home" || action.startsWith("provider:")
        ? "Couldn't refresh this menu. Reopen /models and try again."
        : `Couldn't confirm the ${setting} change. Use /status to check it, then reopen /${menu.kind} to retry.`);
    } finally { menu.working = false; }
  }
}
