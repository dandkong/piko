export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  /** User messages carry their submission identity; assistant messages are independent. */
  runId?: string;
};

export type StreamEvent = (
  | { type: "message"; message: Message; final: boolean; previousId?: string }
  | { type: "refresh" }
  | { type: "done" }
  | { type: "cancelled" }
  | { type: "error"; message: string }
) & { runId?: string; sequence?: number };

export function isStreamTerminal(event: StreamEvent): boolean {
  return event.type === "done" || event.type === "cancelled" || event.type === "error";
}

export type RunStatus = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export type RunSnapshot = {
  id: string;
  status: RunStatus;
  message: string;
  createdAt: number;
  lastEventId: number;
  error?: string;
  errorCode?: "interrupted";
  retryOfRunId?: string;
};

export function isRunActive(run: RunSnapshot): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "cancelling";
}

export type ChatRequest = { sessionId: string; message: string; runId?: string; after?: number; retryOfRunId?: string };
export type ConversationResponse = { sessionId: string; messages: Message[]; run?: RunSnapshot };
export type HealthResponse = {
  ok: boolean;
  app: "Piko";
  runtime: "Pi";
  modelReady: boolean;
  activeSessions: number;
};

export const MAX_MESSAGE_LENGTH = 12_000;
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && sessionIdPattern.test(value);
}
