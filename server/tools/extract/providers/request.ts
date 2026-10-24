import { readResponseText, WebRequestError, withRequestSignal, type WebFetch } from "../../http";
import type { RemoteWebExtractProviderId } from "./types";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
type JsonObject = Record<string, unknown>;

export function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
export function httpUrl(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch { return undefined; }
}

export async function requestJson(
  provider: RemoteWebExtractProviderId,
  url: string,
  init: RequestInit,
  options: { fetch?: WebFetch; timeoutMs?: number },
  signal?: AbortSignal,
): Promise<JsonObject> {
  return withRequestSignal(signal, options.timeoutMs ?? 45_000, `Web extraction via ${provider}`, async requestSignal => {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(url, { ...init, redirect: "error", signal: requestSignal });
    } catch {
      requestSignal.throwIfAborted();
      throw new WebRequestError(`${provider} extraction request failed.`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new WebRequestError(`${provider} extraction returned HTTP ${response.status}.`);
    }
    const body = await readResponseText(response, MAX_RESPONSE_BYTES, requestSignal);
    let value: unknown;
    try { value = JSON.parse(body); } catch { throw new WebRequestError(`${provider} extraction returned invalid JSON.`); }
    const data = record(value);
    if (!data || data.error || data.errors) throw new WebRequestError(`${provider} extraction returned an invalid response.`);
    return data;
  });
}
