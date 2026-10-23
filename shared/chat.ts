import type { ActiveCompaction } from "./runtime";
/** A stored attachment; the model sees its path, the UI only needs the served URL. */
export type MessageAttachment = { id: string; url: string; mime: string };
export type Message = { id: string; role: "user" | "assistant"; content: string; createdAt: number; requestId?: string; attachments?: MessageAttachment[] };
export type SubmissionReceipt = { id: string; requestId?: string; status: "queued" | "placed" | "done" | "unanswered"; error?: string };
export const CHAT_PAGE_SIZE = 50;
/** Images a single message may carry; each one is read by the model as a separate file. */
export const MAX_ATTACHMENTS = 4;
export type HistoryPage = { messages: Message[]; nextBefore?: string };
/** Prompt size of the last model call; a reference point, not a live token count. */
export type ChatUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; contextWindow?: number; ratio?: number };
/** One tool call of the current run; live-only, never part of saved history. */
export type ToolActivity = { callId: string; name: string; summary: string; status: "running" | "done" | "error"; durationMs?: number };
/** A snapshot's history window is authoritative; older pages remain client-side. */
export type ConversationResponse = { messages: Message[]; history?: { nextBefore?: string }; busy: boolean; latest?: SubmissionReceipt; interruption?: string; previousIds?: Record<string, string>; usage?: ChatUsage; compactions?: ActiveCompaction[] };
export function isHistoryCursor(value: string): boolean { return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)); }
export type StreamEvent =
  | { type: "message"; message: Message; final: boolean; previousId?: string }
  | { type: "tool"; activity: ToolActivity }
  | { type: "tool-clear" }
  | { type: "refresh" }
  | { type: "deleted" }
  | { type: "snapshot"; conversation: ConversationResponse }
  | { type: "error"; message: string };
export type HealthResponse = { ok: boolean; app: "Piko"; runtime: "Pi"; modelReady: boolean; activeSessions: number };
export const MAX_MESSAGE_LENGTH = 12_000;
export function isRequestId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 250 && !value.startsWith("piko:"); }
