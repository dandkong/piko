import type { ConversationResponse, HealthResponse, HistoryPage, MessageAttachment } from "../../../../../shared/chat";
import { chatPath } from "../../../../../shared/side-chats";
import { apiFetch, readJson } from "../../api/client";
import { observeConversation, submitMessage } from "./transport";
async function chatJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController(); const abort = () => controller.abort();
  const timer = setTimeout(abort, 10000); init.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (init.signal?.aborted) abort();
    return await readJson<T>(await apiFetch(path, { ...init, signal: controller.signal }));
  } finally { clearTimeout(timer); init.signal?.removeEventListener("abort", abort); }
}
export function checkHealth(): Promise<HealthResponse> { return chatJson("/api/health"); }
export function loadConversation(signal?: AbortSignal, id?: string): Promise<ConversationResponse> { return chatJson(chatPath(id), { signal }); }
export function loadHistory(before: string, signal?: AbortSignal, id?: string): Promise<HistoryPage> { return chatJson(`${chatPath(id)}/history?before=${encodeURIComponent(before)}`, { signal }); }
export function observe(options: Parameters<typeof observeConversation>[0], id?: string) { return observeConversation(options, { fetch: apiFetch }, chatPath(id)); }
export function submit(message: string, requestId: string, signal: AbortSignal, attachmentIds?: string[], id?: string) {
  return submitMessage(message, requestId, signal, { fetch: apiFetch }, attachmentIds, chatPath(id));
}

/** A file chosen on this device, uploaded before the message is sent. */
export type PickedFile = { name: string; mime: string; bytes: Blob };

export async function uploadAttachment(file: PickedFile): Promise<MessageAttachment> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await apiFetch(`/api/attachments?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": file.mime || "application/octet-stream" },
      body: file.bytes,
      signal: controller.signal,
    });
    return await readJson<MessageAttachment>(response);
  } finally { clearTimeout(timer); }
}
export async function stopConversation(requestId: string, id?: string) { await chatJson(`${chatPath(id)}/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId }) }); }
export function isAbortError(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }
