export type Message = { id: string; role: "user" | "assistant"; content: string; createdAt: number; requestId?: string };
export type SubmissionReceipt = { id: string; requestId?: string; status: "queued" | "placed" | "done" | "unanswered"; error?: string };
export const CHAT_PAGE_SIZE = 50;
export type HistoryPage = { messages: Message[]; nextBefore?: string };
/** Prompt size of the last model call; a reference point, not a live token count. */
export type ChatUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; contextWindow?: number; ratio?: number };
/** A snapshot's history window is authoritative; older pages remain client-side. */
export type ConversationResponse = { messages: Message[]; history?: { nextBefore?: string }; busy: boolean; latest?: SubmissionReceipt; interruption?: string; previousIds?: Record<string, string>; usage?: ChatUsage };
export function isHistoryCursor(value: string): boolean { return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)); }
export type StreamEvent =
  | { type: "message"; message: Message; final: boolean; previousId?: string }
  | { type: "refresh" }
  | { type: "snapshot"; conversation: ConversationResponse }
  | { type: "error"; message: string };
export type HealthResponse = { ok: boolean; app: "Piko"; runtime: "Pi"; modelReady: boolean; activeSessions: number };
export const MAX_MESSAGE_LENGTH = 12_000;
export function isRequestId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 250 && !value.startsWith("piko:"); }
