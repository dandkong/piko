import type { ConversationResponse, HealthResponse, HistoryPage } from "../../../../../shared/chat";
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
export function loadConversation(signal?: AbortSignal): Promise<ConversationResponse> { return chatJson("/api/chat", { signal }); }
export function loadHistory(before: string, signal?: AbortSignal): Promise<HistoryPage> { return chatJson(`/api/chat/history?before=${encodeURIComponent(before)}`, { signal }); }
export function observe(options: Parameters<typeof observeConversation>[0]) { return observeConversation(options, { fetch: apiFetch }); }
export function submit(message: string, requestId: string, signal: AbortSignal) { return submitMessage(message, requestId, signal, { fetch: apiFetch }); }
export async function stopConversation(requestId: string) { await chatJson("/api/chat/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId }) }); }
export function isAbortError(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }
