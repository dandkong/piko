import type { ConversationResponse, HealthResponse, HistoryPage, MessageAttachment } from "../../../../../shared/chat";
import { chatPath } from "../../../../../shared/side-chats";
import { apiFetch, readJson } from "../../api/client";
import { observeConversation, submitMessage } from "./transport";
async function chatJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  return readJson<T>(await apiFetch(path, { ...init, timeoutMs: 10_000 }));
}
export function checkHealth(): Promise<HealthResponse> { return chatJson("/api/health"); }
export function loadConversation(signal?: AbortSignal, id?: string): Promise<ConversationResponse> { return chatJson(chatPath(id), { signal }); }
export function loadHistory(before: string, signal?: AbortSignal, id?: string): Promise<HistoryPage> { return chatJson(`${chatPath(id)}/history?before=${encodeURIComponent(before)}`, { signal }); }
export function observe(options: Parameters<typeof observeConversation>[0], id?: string) { return observeConversation(options, { fetch: (path, init) => apiFetch(path, { ...init, timeoutMs: 0 }) }, chatPath(id)); }
export function submit(message: string, requestId: string, signal: AbortSignal, attachmentIds?: string[], id?: string) {
  return submitMessage(message, requestId, signal, { fetch: (path, init) => apiFetch(path, { ...init, timeoutMs: 0 }) }, attachmentIds, chatPath(id));
}

/** A file chosen on this device, uploaded before the message is sent. */
export type PickedFile = { name: string; mime: string; bytes: Blob };

export async function uploadAttachment(file: PickedFile): Promise<MessageAttachment> {
    const response = await apiFetch(`/api/attachments?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": file.mime || "application/octet-stream" },
      body: file.bytes,
      timeoutMs: 30_000,
    });
    return readJson<MessageAttachment>(response);
}
export function attachmentActionUrl(url: string, action: "play" | "preview" | "download"): string {
  return `${url}${url.includes("?") ? "&" : "?"}${action}=1`;
}
export async function stopConversation(requestId: string, id?: string) { await chatJson(`${chatPath(id)}/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId }) }); }
export { isAbortError } from "../../api/errors";
