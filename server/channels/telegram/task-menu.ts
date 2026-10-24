import type { AssistantTask, AssistantTaskDetail, TaskExecution } from "../../../shared/tasks";
import type { ChatRuntime } from "../../runtime/types";
import { singleLine } from "../../runtime/tool-activity";
import type { TelegramCallback } from "./menus";
import { isFormatError, type TelegramKeyboard, type TelegramTransport } from "./api";

type Address = { chatId: string; messageId: string };
type View = { text: string; buttons?: TelegramKeyboard };
type TaskFilter = "active" | "archived";

const PAGE_SIZE = 6;
const EXECUTION_LIMIT = 5;
const RESULT_TEXT_LIMIT = 3500;
const filterCode = (filter: TaskFilter) => filter === "active" ? "a" : "r";
const decodeFilter = (value: string): TaskFilter | undefined => value === "a" ? "active" : value === "r" ? "archived" : undefined;
const taskKey = (id: string, filter: TaskFilter, page: number) => `t:d:${id}:${filterCode(filter)}:${page.toString(36)}`;

function taskListKey(filter: TaskFilter, page: number): string {
  return `t:l:${filterCode(filter)}:${page.toString(36)}`;
}
function taskResultKey(taskId: string, runId: string, filter: TaskFilter, page: number): string {
  return `t:r:${taskId}:${runId}:${filterCode(filter)}:${page.toString(36)}`;
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
function shortId(id: string): string { return id.replace(/-/g, "").slice(0, 8); }
function taskButton(task: AssistantTask, filter: TaskFilter, page: number) {
  return {
    text: `${singleLine(task.title, 34) ?? "Untitled"} · #${shortId(task.id)}`,
    callbackData: assertCallbackData(taskKey(task.id, filter, page)),
  };
}
function taskListView(all: AssistantTask[], filter: TaskFilter, requestedPage: number): View {
  const filtered = all.filter(task => task.status === filter);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(Math.max(requestedPage, 0), pages - 1);
  const tasks = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const archivedCount = all.filter(task => task.status === "archived").length;
  const activeCount = all.length - archivedCount;
  const lines = [
    `${filter === "active" ? "Active" : "Archived"} tasks (${filtered.length})${pages > 1 ? ` · Page ${page + 1}/${pages}` : ""}`,
    "Choose a task to view its details and recent executions:",
    "",
    ...tasks.map(task => {
      const latest = task.latest
        ? ` · ${statusIcon(task.latest.status)} ${statusLabel(task.latest.status)}${task.latest.preview ? ` — ${singleLine(task.latest.preview, 72)}` : ""}`
        : " · No executions";
      return `• ${singleLine(task.title, 72) ?? "Untitled"} · ${singleLine(task.scheduleText, 40) ?? "Manual"}${latest}`;
    }),
    ...(!tasks.length ? [filter === "active" ? "No active tasks." : "No archived tasks."] : []),
  ];
  const buttons: TelegramKeyboard = [];
  for (let i = 0; i < tasks.length; i += 2)
    buttons.push(tasks.slice(i, i + 2).map(task => taskButton(task, filter, page)));
  buttons.push([{ text: filter === "active" ? `Show archived (${archivedCount})` : `Show active (${activeCount})`, callbackData: taskListKey(filter === "active" ? "archived" : "active", 0) }]);
  if (pages > 1) {
    const navigation: TelegramKeyboard[number] = [];
    if (page > 0) navigation.push({ text: "‹ Previous", callbackData: taskListKey(filter, page - 1) });
    if (page < pages - 1) navigation.push({ text: "Next ›", callbackData: taskListKey(filter, page + 1) });
    buttons.push(navigation);
  }
  return { text: lines.join("\n"), buttons };
}
function taskDetailView(detail: AssistantTaskDetail, filter: TaskFilter, page: number): View {
  const { task } = detail;
  const executions = detail.executions.slice(0, EXECUTION_LIMIT);
  const lines = [
    `${task.title} · #${shortId(task.id)}`,
    `Status: ${task.status === "active" ? "Active" : "Archived"}`,
    `Schedule: ${task.scheduleText}`,
    ...(task.nextDueAt === null ? [] : [`Next run: ${dateTime(task.nextDueAt)}`]),
    "",
    "Instructions:",
    singleLine(task.prompt, 900) ?? "(empty)",
    "",
    "Recent executions:",
    ...(executions.length ? executions.map(run =>
      `${statusIcon(run.status)} ${dateTime(run.startedAt)} · ${statusLabel(run.status)}${run.preview ? ` — ${singleLine(run.preview, 100)}` : ""}`,
    ) : ["No executions yet."]),
  ];
  const buttons: TelegramKeyboard = [];
  const resultButtons = executions
    .filter(run => run.status !== "running")
    .map(run => ({
      text: `${statusIcon(run.status)} ${dateTime(run.startedAt)} · #${run.id.slice(-4)}`,
      callbackData: assertCallbackData(taskResultKey(task.id, run.id, filter, page)),
    }));
  for (let i = 0; i < resultButtons.length; i += 2)
    buttons.push(resultButtons.slice(i, i + 2));
  buttons.push([{ text: "Back to task list", callbackData: taskListKey(filter, page) }]);
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
    const view = taskListView(all, "active", 0);
    await this.api.send(address.chatId, view.text, false, view.buttons);
  }

  private async editTaskList(callback: TelegramCallback, filter: TaskFilter, page: number): Promise<void> {
    const all = await (await this.runtime.tasks()).list();
    const view = taskListView(all, filter, page);
    await this.api.edit(callback.chatId, callback.messageId, view.text, false, view.buttons);
  }

  private async editTaskDetail(callback: TelegramCallback, id: string, filter: TaskFilter, page: number): Promise<void> {
    const detail = await (await this.runtime.tasks()).detail(id);
    const view = taskDetailView(detail, filter, page);
    await this.api.edit(callback.chatId, callback.messageId, view.text, false, view.buttons);
  }

  private async editExecutionResult(callback: TelegramCallback, id: string, runId: string, filter: TaskFilter, page: number): Promise<void> {
    const service = await this.runtime.tasks();
    const [result, detail] = await Promise.all([service.result(id, runId), service.detail(id)]);
    const answer = truncateResult(result.answer.trim() || "No text result.");
    const text = [
      `${detail.task.title} · ${dateTime(result.execution.startedAt)} · ${statusLabel(result.execution.status)}`,
      "",
      answer,
    ].join("\n");
    const buttons: TelegramKeyboard = [[{ text: "Back to task", callbackData: assertCallbackData(taskKey(id, filter, page)) }]];
    try {
      await this.api.edit(callback.chatId, callback.messageId, text, true, buttons);
    } catch (error) {
      if (!isFormatError(error)) throw error;
      await this.api.edit(callback.chatId, callback.messageId, text, false, buttons);
    }
  }

  async handle(callback: TelegramCallback): Promise<void> {
    const list = /^t:l:([ar]):([0-9a-z]+)$/.exec(callback.data);
    const detail = /^t:d:([a-zA-Z0-9-]{1,80}):([ar]):([0-9a-z]+)$/.exec(callback.data);
    const result = /^t:r:([a-zA-Z0-9-]{1,80}):([1-9][0-9]*):([ar]):([0-9a-z]+)$/.exec(callback.data);
    if (!list && !detail && !result) {
      await this.api.answerCallback(callback.callbackId, "This task menu is no longer available. Reopen /task.", true);
      return;
    }
    const messageKey = `${callback.chatId}:${callback.messageId}`;
    if (this.working.has(messageKey)) {
      await this.api.answerCallback(callback.callbackId, "One moment…");
      return;
    }
    this.working.add(messageKey);
    try {
      if (list) await this.editTaskList(callback, decodeFilter(list[1])!, parseInt(list[2], 36));
      else if (detail) await this.editTaskDetail(callback, detail[1], decodeFilter(detail[2])!, parseInt(detail[3], 36));
      else await this.editExecutionResult(callback, result![1], result![2], decodeFilter(result![3])!, parseInt(result![4], 36));
      await this.api.answerCallback(callback.callbackId);
    } catch {
      await this.api.answerCallback(callback.callbackId, "Couldn't load this task view. Reopen /task and try again.", true);
    } finally {
      this.working.delete(messageKey);
    }
  }
}
