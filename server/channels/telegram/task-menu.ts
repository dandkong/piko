import type { AssistantTask, AssistantTaskDetail, TaskExecution } from "../../../shared/tasks";
import type { ChatRuntime } from "../../runtime/types";
import { singleLine } from "../../runtime/tool-activity";
import type { TelegramCallback } from "./menus";
import { isFormatError, type TelegramKeyboard, type TelegramTransport } from "./api";

type Address = { chatId: string; messageId: string };
type View = { text: string; buttons?: TelegramKeyboard };
class TaskMenuNotice extends Error {}

const PAGE_SIZE = 6;
const EXECUTION_LIMIT = 5;
const RESULT_TEXT_LIMIT = 3500;
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
  const pages = Math.max(1, Math.ceil(tasks.length / PAGE_SIZE));
  const page = Math.min(Math.max(requestedPage, 0), pages - 1);
  const visible = tasks.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const lines = [
    ...visible.map(task =>
      `#${shortId(task, ids)} · ${singleLine(task.title, 72) ?? "Untitled"} · ${singleLine(task.scheduleText, 40) ?? "Manual"}`,
    ),
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
  return { text: lines.join("\n"), buttons };
}
function taskDetailView(detail: AssistantTaskDetail, page: number, id: string): View {
  const { task } = detail;
  const executions = detail.executions.slice(0, EXECUTION_LIMIT);
  const runIds = shortRunIds(executions);
  const lines = [
    `#${id} · ${task.title}`,
    `Status: Active`,
    `Schedule: ${task.scheduleText}`,
    ...(task.nextDueAt === null ? [] : [`Next run: ${dateTime(task.nextDueAt)}`]),
    "",
    "Instructions:",
    singleLine(task.prompt, 900) ?? "(empty)",
    "",
    "Recent executions:",
    ...(executions.length ? executions.map(run =>
      `#${runIds.get(run.id)} · ${statusIcon(run.status)} ${dateTime(run.startedAt)} · ${statusLabel(run.status)}${run.preview ? ` — ${singleLine(run.preview, 100)}` : ""}`,
    ) : ["No executions yet."]),
  ];
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
  return { text: lines.join("\n"), buttons };
}
function truncateResult(value: string): string {
  if (value.length <= RESULT_TEXT_LIMIT) return value;
  let end = RESULT_TEXT_LIMIT - 64;
  if (end > 0 && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
  return `${value.slice(0, end)}\n\n… Result truncated. Open Piko to read the full execution.`;
}

/** Stateless task/list/execution callbacks re-read the persisted task facts on every click. */
export class TelegramTaskMenus {
  private readonly working = new Set<string>();
  constructor(private readonly runtime: Pick<ChatRuntime, "tasks">, private readonly api: TelegramTransport) {}

  async open(address: Address): Promise<void> {
    const all = await (await this.runtime.tasks()).list();
    const view = taskListView(all, 0);
    await this.api.send(address.chatId, view.text, false, view.buttons);
  }

  private async editTaskList(callback: TelegramCallback, page: number): Promise<void> {
    const all = await (await this.runtime.tasks()).list();
    const view = taskListView(all, page);
    await this.api.edit(callback.chatId, callback.messageId, view.text, false, view.buttons);
  }

  private async editTaskDetail(callback: TelegramCallback, id: string, page: number): Promise<void> {
    const service = await this.runtime.tasks();
    const [detail, all] = await Promise.all([service.detail(id), service.list()]);
    if (detail.task.status !== "active") throw new TaskMenuNotice("Task archived.");
    const view = taskDetailView(detail, page, shortId(detail.task, shortTaskIds(all)));
    await this.api.edit(callback.chatId, callback.messageId, view.text, false, view.buttons);
  }

  private async editExecutionResult(callback: TelegramCallback, id: string, runId: string, page: number): Promise<void> {
    const service = await this.runtime.tasks();
    const [result, detail, all] = await Promise.all([service.result(id, runId), service.detail(id), service.list()]);
    if (detail.task.status !== "active") throw new TaskMenuNotice("Task archived.");
    const answer = truncateResult(result.answer.trim() || "No text result.");
    const runIdShort = shortRunIds(detail.executions.slice(0, EXECUTION_LIMIT)).get(runId) ?? runId.slice(-4);
    const text = [
      `#${shortId(detail.task, shortTaskIds(all))} · ${detail.task.title} · Run #${runIdShort} · ${dateTime(result.execution.startedAt)} · ${statusLabel(result.execution.status)}`,
      "",
      answer,
    ].join("\n");
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
