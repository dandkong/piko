import { readResponseText, withRequestSignal } from "../http";
import { SearchProviderFailure, type ProviderOptions, type SearchProviderId } from "./types";

const MAX_RESPONSE_BYTES = 1024 * 1024;
type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);

export function record(value: unknown): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}
export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
export function httpUrl(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch { return undefined; }
}

export async function requestJson(
  provider: SearchProviderId,
  url: string | URL,
  init: RequestInit,
  options: ProviderOptions,
  signal?: AbortSignal,
): Promise<unknown> {
  return withRequestSignal(signal, options.timeoutMs ?? 15000, "Web search", async requestSignal => {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(url, { ...init, redirect: "error", signal: requestSignal });
    } catch {
      requestSignal.throwIfAborted();
      throw new SearchProviderFailure(provider);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SearchProviderFailure(provider, response.status);
    }
    const body = await readResponseText(response, MAX_RESPONSE_BYTES, requestSignal);
    let value: unknown;
    try { value = JSON.parse(body); } catch { throw new SearchProviderFailure(provider, response.status); }
    if (!isObject(value) || value.error || value.errors) throw new SearchProviderFailure(provider, response.status);
    return value;
  });
}
