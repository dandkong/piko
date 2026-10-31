/** Typed transport failures; UI owners decide where and how to present them. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
export class RequestTimeoutError extends Error {
  constructor() { super("请求超时，暂未确认结果，请核对后重试。"); }
}
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof RequestTimeoutError ? error.message : fallback;
}
