import type { ChatRuntime, SubagentDetail, SubagentListItem } from "../../runtime/types";
import { DETAIL_TEXT_LIMIT, SUMMARY_TEXT_LIMIT, singleLine } from "../../runtime/text";
import type { TelegramCallback } from "./menus";
import type { TelegramKeyboard, TelegramTransport } from "./api";

type Address = { chatId: string; messageId: string };
type View = { text: string; buttons?: TelegramKeyboard };

const LIST_LIMIT = 4;

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

function listView(all: SubagentListItem[]): View {
  const items = newestFirst(all).slice(0, LIST_LIMIT);
  if (!items.length) return { text: "Background subagents\nNo subagents yet." };
  return {
    text: [
      `Background subagents · showing ${items.length} of ${all.length}`,
      "Newest first. Choose an ID to view its latest status and five recent steps:",
      "",
      ...items.map(item => singleLine(
        `${statusIcon(item.status)} #${item.id} · ${item.status} · ${item.title.trim() || item.task.trim() || "(no task description)"}`,
        SUMMARY_TEXT_LIMIT,
      )!),
    ].join("\n"),
    buttons: [items.map(item => ({
      text: `#${item.id}`,
      callbackData: `s:detail:${item.id}`,
    }))],
  };
}

function detailView(item: SubagentListItem, detail: SubagentDetail): View {
  return {
    text: [
      `Background subagent #${detail.id}`,
      `Title: ${singleLine(item.title, DETAIL_TEXT_LIMIT) ?? singleLine(item.task, DETAIL_TEXT_LIMIT) ?? "(no task description)"}`,
      `Task: ${singleLine(item.task, DETAIL_TEXT_LIMIT) ?? "(no task description)"}`,
      `Status: ${detail.status}`,
      ...(detail.detail ? [`Detail: ${singleLine(detail.detail, DETAIL_TEXT_LIMIT)}`] : []),
      "",
      "Recent steps:",
      ...(detail.recentSteps.length
        ? detail.recentSteps.map(step => singleLine(`• ${step}`, DETAIL_TEXT_LIMIT)!)
        : ["(none yet)"]),
    ].join("\n"),
    buttons: [[{ text: "Back to list", callbackData: "s:list" }]],
  };
}

/** Stateless ID callbacks survive Piko restarts; each click re-reads Durable facts. */
export class TelegramSubagentMenus {
  private readonly working = new Set<string>();

  constructor(private readonly runtime: Pick<ChatRuntime, "subagents">, private readonly api: TelegramTransport) {}

  async open(address: Address): Promise<void> {
    const items = await (await this.runtime.subagents()).list();
    const view = listView(items);
    await this.api.send(address.chatId, view.text, false, view.buttons);
  }

  async handle(callback: TelegramCallback): Promise<void> {
    // Legacy callback forms from older list menus are still understood. Old page buttons
    // reopen the new latest-four view rather than trying to restore an in-memory page.
    const current = /^s:(list|detail:(\d+))$/.exec(callback.data);
    const legacy = /^s:[\da-f-]{12}:(back|page:\d+|detail:(\d+))$/.exec(callback.data);
    const action = current
      ? current[1] === "list" ? "list" : "detail"
      : legacy
        ? legacy[1] === "detail" ? "detail" : "list"
        : undefined;
    const id = current?.[2] ?? legacy?.[2];
    if (!action || action === "detail" && !id) {
      await this.api.answerCallback(callback.callbackId, "Menu expired. Reopen /subagent.", false);
      return;
    }
    const messageKey = `${callback.chatId}:${callback.messageId}`;
    if (this.working.has(messageKey)) {
      await this.api.answerCallback(callback.callbackId, "One moment…");
      return;
    }
    this.working.add(messageKey);
    try {
      const service = await this.runtime.subagents();
      if (action === "list") {
        const view = listView(await service.list());
        await this.api.edit(callback.chatId, callback.messageId, view.text, false, view.buttons);
      } else {
        const [items, detail] = await Promise.all([
          service.list(),
          service.status(id!),
        ]);
        const item = items.find(value => value.id === id);
        if (!item || !detail) {
          await this.api.answerCallback(callback.callbackId, "Subagent unavailable.", false);
          return;
        }
        const view = detailView(item, detail);
        await this.api.edit(callback.chatId, callback.messageId, view.text, false, view.buttons);
      }
      await this.api.answerCallback(callback.callbackId);
    } catch {
      await this.api.answerCallback(callback.callbackId, "Couldn't refresh /subagent. Try again.", false);
    } finally {
      this.working.delete(messageKey);
    }
  }
}
