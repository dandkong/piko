import type { ItemExecutionDetail, ItemFile, WorkItem, WorkItemCommand, WorkItemDetail, WorkItemReceipt } from "../../../../../shared/work-items";
import { apiFetch, readJson } from "../../api/client";

async function get<T>(path: string, signal?: AbortSignal) {
  return readJson<T>(await apiFetch(path, { signal }));
}
export const loadItems = (signal?: AbortSignal) => get<{ items: WorkItem[] }>("/api/items", signal);
export const loadItem = (id: string, signal?: AbortSignal, before?: string) => get<WorkItemDetail>(`/api/items/${encodeURIComponent(id)}${before ? `?before=${encodeURIComponent(before)}` : ""}`, signal);
export const loadExecution = (id: string, execution: string, signal?: AbortSignal) => get<ItemExecutionDetail>(`/api/items/${encodeURIComponent(id)}/executions/${encodeURIComponent(execution)}`, signal);
export const loadOutput = (id: string, execution: string, path: string, signal?: AbortSignal) => get<ItemFile>(`/api/items/${encodeURIComponent(id)}/executions/${encodeURIComponent(execution)}/file?path=${encodeURIComponent(path)}`, signal);
export async function sendCommand(command: WorkItemCommand) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try {
    return await readJson<WorkItemReceipt>(await apiFetch("/api/items", { method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) }));
  } finally { clearTimeout(timer); }
}
