import type { TaskExecutionDetail, AssistantTask, AssistantTaskCommand, AssistantTaskDetail, AssistantTaskReceipt } from "../../../../../shared/tasks";
import { apiFetch, readJson } from "../../api/client";

async function get<T>(path: string, signal?: AbortSignal) {
  return readJson<T>(await apiFetch(path, { signal }));
}
export const loadTasks = (signal?: AbortSignal) => get<{ tasks: AssistantTask[] }>("/api/tasks", signal);
export const loadTask = (id: string, signal?: AbortSignal, before?: string) => get<AssistantTaskDetail>(`/api/tasks/${encodeURIComponent(id)}${before ? `?before=${encodeURIComponent(before)}` : ""}`, signal);
export const loadExecution = (id: string, execution: string, signal?: AbortSignal) => get<TaskExecutionDetail>(`/api/tasks/${encodeURIComponent(id)}/executions/${encodeURIComponent(execution)}`, signal);
export async function sendCommand(command: AssistantTaskCommand) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), command.action === "delete" ? 120000 : 15000);
  try {
    return await readJson<AssistantTaskReceipt>(await apiFetch("/api/tasks", { method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) }));
  } finally { clearTimeout(timer); }
}
