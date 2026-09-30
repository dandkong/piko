import type {
  ChatRequest,
  ConversationResponse,
  HealthResponse,
  Message,
  StreamEvent,
} from "../../../../../shared/chat";
import { consumeSse } from "../../../../../shared/sse";
import { apiFetch, readJson, requestJson } from "../../api/client";

export function checkHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>("/api/health");
}

export async function loadConversation(sessionId: string): Promise<Message[]> {
  const result = await requestJson<ConversationResponse>(`/api/sessions/${encodeURIComponent(sessionId)}`);
  return result.messages;
}

export async function streamMessage(
  sessionId: string,
  message: string,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const response = await apiFetch("/api/chat", {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId, message } satisfies ChatRequest),
    signal,
  });

  if (!response.ok) {
    await readJson<unknown>(response);
    return;
  }
  if (!response.body) throw new Error("This runtime did not provide a streaming response body.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const parsed = consumeSse(pending, done);
      pending = parsed.remainder;
      parsed.events.forEach(onEvent);
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
