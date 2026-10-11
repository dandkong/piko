export type Message = { id: string; role: "user" | "assistant"; content: string; createdAt: number; requestId?: string };
export type SubmissionReceipt = { id: string; requestId?: string; status: "queued" | "placed" | "done" | "unanswered"; error?: string };
export type ConversationResponse = { messages: Message[]; busy: boolean; latest?: SubmissionReceipt; interruption?: string; previousIds?: Record<string, string> };
export type StreamEvent = (
  | { type: "message"; message: Message; final: boolean; previousId?: string }
  | { type: "refresh" }
  | { type: "snapshot"; conversation: ConversationResponse }
  | { type: "error"; message: string }
) & { epoch?: string; sequence?: number };
export type HealthResponse = { ok: boolean; app: "Piko"; runtime: "Pi"; modelReady: boolean; activeSessions: number };
export const MAX_MESSAGE_LENGTH = 12_000;
export function isRequestId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 250; }
