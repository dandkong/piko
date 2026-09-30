export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
};

export type StreamEvent = (
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "cancelled" }
  | { type: "error"; message: string }
) & { runId?: string; sequence?: number };

export type RunStatus = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export type RunSnapshot = {
  id: string;
  status: RunStatus;
  message: string;
  text: string;
  createdAt: number;
  lastEventId: number;
  error?: string;
};

export function isRunActive(run: RunSnapshot): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "cancelling";
}

export type ChatRequest = { sessionId: string; message: string; runId?: string; after?: number };
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
