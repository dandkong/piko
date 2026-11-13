import type { MessageKey } from "../i18n/messages";

/** Typed transport failures; UI owners decide where and how to present them. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
export class LocalApiError extends ApiError {
  constructor(readonly messageKey: MessageKey, status: number, code?: string) { super(messageKey, status, code); }
}
export class RequestTimeoutError extends Error {
  constructor() { super("api.timeout"); }
}
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
export function errorMessage(error: unknown, fallback: string, t?: (key: MessageKey) => string): string {
  if (error instanceof RequestTimeoutError) return t ? t("api.timeout") : fallback;
  if (error instanceof LocalApiError) return t ? t(error.messageKey) : fallback;
  return error instanceof ApiError ? error.message : fallback;
}
