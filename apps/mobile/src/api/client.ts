import { fetch } from "expo/fetch";
import { Platform } from "react-native";
import { ApiError, LocalApiError, RequestTimeoutError } from "./errors";

const DEFAULT_API_URL = Platform.OS === "web" ? (__DEV__ ? `http://${window.location.hostname}:8787` : "")
  : Platform.OS === "android" ? "http://10.0.2.2:8787" : "http://127.0.0.1:8787";
export let API_URL = (process.env.EXPO_PUBLIC_PIKO_API_URL || DEFAULT_API_URL).replace(/\/$/, "");
let sessionToken: string | undefined;
let onUnauthorized: (() => void) | undefined;
export function setApiUrl(url: string) { API_URL = url.replace(/\/$/, ""); }
export function setSessionToken(token?: string) { sessionToken = token; }
export function setUnauthorizedHandler(handler?: () => void) { onUnauthorized = handler; }
export function authHeaders(url: string): Record<string, string> {
  if (!sessionToken || Platform.OS === "web") return {};
  try { if (new URL(url, API_URL).origin !== new URL(API_URL).origin) return {}; } catch { return {}; }
  return { Authorization: `Bearer ${sessionToken}` };
}

// Keep cancellation and the deadline alive until readJson consumes the body, not just the headers.
const pendingResponses = new WeakMap<Response, { close: () => void; timedOut: () => boolean }>();
export async function apiFetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 15_000, signal, ...options } = init;
  const headers = new Headers(options.headers);
  for (const [name, value] of Object.entries(authHeaders(`${API_URL}${path}`))) headers.set(name, value);
  const authenticatedOptions = { ...options, headers, credentials: "include" as const };
  const check = (response: Response) => { if (response.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized?.(); return response; };
  // SSE and message submission own their lifetime; preserve their original signal through body reads.
  if (timeoutMs === 0) return check(await fetch(`${API_URL}${path}`, { ...authenticatedOptions, signal }));
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timedOut = false;
  const close = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
  const timer = setTimeout(() => { timedOut = true; abort(); close(); }, timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const response = check(await fetch(`${API_URL}${path}`, { ...authenticatedOptions, signal: controller.signal }));
    if (response.status === 204 || response.status === 205 || options.method === "HEAD") close();
    else pendingResponses.set(response, { close, timedOut: () => timedOut });
    return response;
  } catch (error) { close(); if (timedOut) throw new RequestTimeoutError(); throw error; }
}

export async function readJson<T>(response: Response): Promise<T> {
  let payload: unknown;
  const pending = pendingResponses.get(response);
  try { payload = await response.json(); }
  catch (error) {
    if (pending?.timedOut()) throw new RequestTimeoutError();
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new LocalApiError("api.invalidResponse", response.status >= 400 ? response.status : 502);
  } finally { pending?.close(); pendingResponses.delete(response); }
  if (!response.ok) {
    const value = payload as { error?: unknown; code?: unknown } | null;
    const code = typeof value?.code === "string" ? value.code : undefined;
    throw typeof value?.error === "string" ? new ApiError(value.error, response.status, code)
      : new LocalApiError("api.failed", response.status, code);
  }
  return payload as T;
}

export async function requestJson<T>(path: string): Promise<T> {
  return readJson<T>(await apiFetch(path));
}
