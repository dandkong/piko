import type { InputRichBlock, InputRichMessage, RichTextButton } from "grammy/types";
import type { AssistantTask, AssistantTaskDetail, TaskExecution } from "../../../shared/tasks";
import type { TasksRuntimeAccess } from "../../runtime/types";
import { DETAIL_TEXT_LIMIT, SUMMARY_TEXT_LIMIT, singleLine, truncateUtf16Text } from "../../runtime/text";
import type { TelegramCallback } from "./menus";
import { isFormatError, isRichMenuError, type TelegramKeyboard, type TelegramTransport } from "./api";
import { TELEGRAM_LONG_TEXT_LIMIT_UTF16, TELEGRAM_MENU_PAGE_SIZE, TELEGRAM_MENU_TEXT_LIMIT } from "./menu-policy";

type Address = { chatId: string; messageId: string };
type View = { text: string; buttons?: TelegramKeyboard; rich?: InputRichMessage };

function richButton(text: string, callbackData: string): RichTextButton {
  return { type: "button", button: { text, callback_data: assertCallbackData(callbackData), style: "primary" } };
}
function richNavigation(buttons: TelegramKeyboard[number]): InputRichBlock {
  return { type: "buttons", align: "right", buttons: buttons.map(button => ({ text: button.text, callback_data: assertCallbackData(button.callbackData) })) };
}
class TaskMenuNotice extends Error {}

const EXECUTION_LIMIT = 5;
const taskKey = (id: string, page: number) => `t:d:${id}:${page.toString(36)}`;
function taskListKey(page: number): string { return `t:l:${page.toString(36)}`; }
function taskResultKey(taskId: string, runId: string, page: number): string {
  return `t:r:${taskId}:${runId}:${page.toString(36)}`;
}
function assertCallbackData(value: string): string {
  if (new TextEncoder().encode(value).byteLength > 64)
    throw new Error("Task callback identity is too long.");
  return value;
}
function dateTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function statusIcon(status: TaskExecution["status"]): string {
  switch (status) {
    case "running": return "🔄";
    case "completed": return "✅";
    case "failed": return "❌";
    case "stopped": return "⏹️";
    case "interrupted": return "⚠️";
  }
}
function statusLabel(status: TaskExecution["status"]): string {
  switch (status) {
    case "running": return "Running";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "stopped": return "Stopped";
    case "interrupted": return "Interrupted";
  }
}
function shortTaskIds(tasks: AssistantTask[]): Map<string, string> {
  const ids = tasks.map(task => ({ id: task.id, value: task.id.replace(/-/g, "") }));
  return new Map(ids.map(item => {
    let length = Math.min(6, item.value.length);
    while (length < item.value.length && ids.some(other =>
      other.id !== item.id && other.value.startsWith(item.value.slice(0, length)),
    )) length++;
    return [item.id, item.value.slice(0, length)];
  }));
}
function shortId(task: AssistantTask, ids: Map<string, string>): string {
  return ids.get(task.id) ?? task.id.replace(/-/g, "").slice(0, 6);
}
function shortRunIds(runs: TaskExecution[]): Map<string, string> {
  return new Map(runs.map(run => {
    let length = Math.min(4, run.id.length);
    while (length < run.id.length && runs.some(other =>
      other.id !== run.id && other.id.endsWith(run.id.slice(-length)),
    )) length++;
    return [run.id, run.id.slice(-length)];
  }));
}
function taskButton(task: AssistantTask, page: number, id: string) {
  return {
    text: `#${id}`,
    callbackData: assertCallbackData(taskKey(task.id, page)),
  };
}
function taskListView(all: AssistantTask[], requestedPage: number): View {
  const ids = shortTaskIds(all);
  const tasks = all.filter(task => task.status === "active").sort((a, b) => b.updatedAt - a.updatedAt);
  const pages = Math.max(1, Math.ceil(tasks.length / TELEGRAM_MENU_PAGE_SIZE));
  const page = Math.min(Math.max(requestedPage, 0), pages - 1);
  const visible = tasks.slice(page * TELEGRAM_MENU_PAGE_SIZE, (page + 1) * TELEGRAM_MENU_PAGE_SIZE);
  const lines = [
    `Active tasks · ${tasks.length}${pages > 1 ? ` · Page ${page + 1}/${pages}` : ""}`,
    ...visible.map(task => singleLine(
      `#${shortId(task, ids)} · ${task.title.trim() || "Untitled"} · ${task.scheduleText.trim() || "Manual"}`,
      SUMMARY_TEXT_LIMIT,
    )!),
    ...(!visible.length ? ["No active tasks."] : []),
  ];
  const buttons: TelegramKeyboard = [];
  for (let i = 0; i < visible.length; i += 2)
    buttons.push(visible.slice(i, i + 2).map(task => taskButton(task, page, shortId(task, ids))));
  if (pages > 1) {
    const navigation: TelegramKeyboard[number] = [];
    if (page > 0) navigation.push({ text: "‹ Previous", callbackData: taskListKey(page - 1) });
    if (page < pages - 1) navigation.push({ text: "Next ›", callbackData: taskListKey(page + 1) });
    buttons.push(navigation);
  }
  const blocks: InputRichBlock[] = [{ type: "paragraph", text: lines[0]! }];
  for (const task of visible) {
    const label = singleLine(`${task.title.trim() || "Untitled"} · ${task.scheduleText.trim() || "Manual"}`, SUMMARY_TEXT_LIMIT) ?? "Untitled";
    blocks.push({ type: "paragraph", text: [label + "  ", richButton("View", taskKey(task.id, page))] });
  }
  if (!visible.length) blocks.push({ type: "paragraph", text: "No active tasks." });
  if (pages > 1) blocks.push(richNavigation(buttons.at(-1)!));
  return { text: lines.join("\n"), buttons, rich: { blocks } };
}
function taskDetailView(detail: AssistantTaskDetail, page: number, id: string): View {
  const { task } = detail;
  const executions = detail.executions.slice(0, EXECUTION_LIMIT);
  const runIds = shortRunIds(executions);
  const beforePrompt = [
    `#${id} · ${singleLine(task.title, DETAIL_TEXT_LIMIT) ?? "Untitled"}`,
    `Status: Active`,
    `Schedule: ${singleLine(task.scheduleText, DETAIL_TEXT_LIMIT) ?? "Manual"}`,
    ...(task.nextDueAt === null ? [] : [`Next run: ${dateTime(task.nextDueAt)}`]),
    "",
    "Instructions:",
  ];
  const afterPrompt = [
    "",
    "Recent executions:",
    ...(executions.length ? executions.map(run => singleLine(
      `#${runIds.get(run.id)} · ${statusIcon(run.status)} ${dateTime(run.startedAt)} · ${statusLabel(run.status)}${run.preview ? ` — ${run.preview}` : ""}`,
      SUMMARY_TEXT_LIMIT,
    )!) : ["No executions yet."]),
  ];
  const fixedLength = [...beforePrompt, "", ...afterPrompt].join("\n").length;
  const promptLimit = Math.max(0, Math.min(TELEGRAM_LONG_TEXT_LIMIT_UTF16, TELEGRAM_MENU_TEXT_LIMIT - fixedLength));
  const prompt = task.prompt.trim()
    ? truncateUtf16Text(task.prompt.trim(), promptLimit, "\n\n[Instructions shortened for Telegram.]")
    : "(empty)";
  const lines = [...beforePrompt, prompt, ...afterPrompt];
  const buttons: TelegramKeyboard = [];
  const resultButtons = executions
    .filter(run => run.status !== "running")
    .map(run => ({
      text: `#${runIds.get(run.id)}`,
      callbackData: assertCallbackData(taskResultKey(task.id, run.id, page)),
    }));
  for (let i = 0; i < resultButtons.length; i += 2)
    buttons.push(resultButtons.slice(i, i + 2));
  buttons.push([{ text: "Back to task list", callbackData: taskListKey(page) }]);
  const blocks: InputRichBlock[] = [
    { type: "paragraph", text: [...beforePrompt, prompt].join("\n") },
    { type: "paragraph", text: "Recent executions:" },
  ];
  if (!executions.length) blocks.push({ type: "paragraph", text: "No executions yet." });
  for (const run of executions) {
    const label = singleLine(`${statusIcon(run.status)} ${dateTime(run.startedAt)} · ${statusLabel(run.status)}${run.preview ? ` — ${run.preview}` : ""}`, SUMMARY_TEXT_LIMIT) ?? "Execution";
    blocks.push({ type: "paragraph", text: run.status === "running" ? label : [label + "  ", richButton("View", taskResultKey(task.id, run.id, page))] });
  }
  blocks.push(richNavigation(buttons.at(-1)!));
  return { text: lines.join("\n"), buttons, rich: { blocks } };
}
function truncateResult(value: string, limit = TELEGRAM_LONG_TEXT_LIMIT_UTF16): string {
  return truncateUtf16Text(value, limit, "\n\n… Result truncated. Open Piko to read the full execution.");
}

/** Stateless task/list/execution callbacks re-read the persisted task facts on every click. */
export class TelegramTaskMenus {
  private readonly working = new Set<string>();
  constructor(private readonly runtime: TasksRuntimeAccess, private readonly api: TelegramTransport) {}

  async open(address: Address): Promise<void> {
    const all = await (await this.runtime.tasks()).list();
    const view = taskListView(all, 0);
    try { await this.api.sendRich(address.chatId, view.rich!); }
    catch (error) {
      if (!isRichMenuError(error)) throw error;
      await this.api.send(address.chatId, view.text, false, view.buttons);
    }
  }

  private async editView(callback: TelegramCallback, view: View): Promise<void> {
    try { await this.api.editRich(callback.chatId, callback.messageId, view.rich!); }
    catch (error) {
      if (!isRichMenuError(error)) throw error;
      await this.api.edit(callback.chatId, callback.messageId, view.text, false, view.buttons);
    }
  }

  private async editTaskList(callback: TelegramCallback, page: number): Promise<void> {
    const all = await (await this.runtime.tasks()).list();
    const view = taskListView(all, page);
    await this.editView(callback, view);
  }

  private async editTaskDetail(callback: TelegramCallback, id: string, page: number): Promise<void> {
    const service = await this.runtime.tasks();
    const [detail, all] = await Promise.all([service.detail(id), service.list()]);
    if (detail.task.status !== "active") throw new TaskMenuNotice("Task archived.");
    const view = taskDetailView(detail, page, shortId(detail.task, shortTaskIds(all)));
    await this.editView(callback, view);
  }

  private async editExecutionResult(callback: TelegramCallback, id: string, runId: string, page: number): Promise<void> {
    const service = await this.runtime.tasks();
    const [result, detail, all] = await Promise.all([service.result(id, runId), service.detail(id), service.list()]);
    if (detail.task.status !== "active") throw new TaskMenuNotice("Task archived.");
    const runIdShort = shortRunIds(detail.executions.slice(0, EXECUTION_LIMIT)).get(runId) ?? runId.slice(-4);
    const heading = `#${shortId(detail.task, shortTaskIds(all))} · ${singleLine(detail.task.title, DETAIL_TEXT_LIMIT) ?? "Untitled"} · Run #${runIdShort} · ${dateTime(result.execution.startedAt)} · ${statusLabel(result.execution.status)}`;
    const answerLimit = Math.max(0, Math.min(TELEGRAM_LONG_TEXT_LIMIT_UTF16, TELEGRAM_MENU_TEXT_LIMIT - heading.length - 2));
    const answer = truncateResult(result.answer.trim() || "No text result.", answerLimit);
    const text = `${heading}\n\n${answer}`;
    const buttons: TelegramKeyboard = [[{ text: "Back to task", callbackData: assertCallbackData(taskKey(id, page)) }]];
    try {
      await this.api.edit(callback.chatId, callback.messageId, text, true, buttons);
    } catch (error) {
      if (!isFormatError(error)) throw error;
      await this.api.edit(callback.chatId, callback.messageId, text, false, buttons);
    }
  }

  async handle(callback: TelegramCallback): Promise<void> {
    const list = /^t:l:([0-9a-z]+)$/.exec(callback.data);
    const detail = /^t:d:([a-zA-Z0-9-]{1,80}):([0-9a-z]+)$/.exec(callback.data);
    const result = /^t:r:([a-zA-Z0-9-]{1,80}):([1-9][0-9]*):([0-9a-z]+)$/.exec(callback.data);
    if (!list && !detail && !result) {
      await this.api.answerCallback(callback.callbackId, "Menu expired. Reopen /task.", false);
      return;
    }
    const messageKey = `${callback.chatId}:${callback.messageId}`;
    if (this.working.has(messageKey)) {
      await this.api.answerCallback(callback.callbackId, "One moment…");
      return;
    }
    this.working.add(messageKey);
    try {
      if (list) await this.editTaskList(callback, parseInt(list[1], 36));
      else if (detail) await this.editTaskDetail(callback, detail[1], parseInt(detail[2], 36));
      else await this.editExecutionResult(callback, result![1], result![2], parseInt(result![3], 36));
      await this.api.answerCallback(callback.callbackId);
    } catch (error) {
      await this.api.answerCallback(callback.callbackId, error instanceof TaskMenuNotice ? error.message : "Couldn't load task. Reopen /task.", false);
    } finally {
      this.working.delete(messageKey);
    }
  }
}
