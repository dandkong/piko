export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
};

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export type ChatRequest = { sessionId: string; message: string };
export type ConversationResponse = { sessionId: string; messages: Message[] };
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
