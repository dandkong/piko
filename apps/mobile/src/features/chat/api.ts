import type {
  ConversationResponse,
  HealthResponse,
} from "../../../../../shared/chat";
import { apiFetch, readJson, requestJson } from "../../api/client";
import { observeRun } from "./transport";

export function checkHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>("/api/health");
}

export async function loadConversation(sessionId: string, signal?: AbortSignal): Promise<ConversationResponse> {
  return readJson<ConversationResponse>(await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { signal }));
}

export function streamMessage(observer: Parameters<typeof observeRun>[0]): Promise<void> {
  return observeRun(observer, { fetch: apiFetch, load: loadConversation });
}

export async function cancelRun(sessionId: string, runId: string): Promise<void> {
  await readJson(await apiFetch(`/api/sessions/${sessionId}/runs/${runId}/cancel`, { method: "POST" }));
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
