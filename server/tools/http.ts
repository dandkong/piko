export type WebFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Keep the timeout active through streamed body reads, not only response headers. */
export async function withRequestSignal<T>(signal: AbortSignal | undefined, timeoutMs: number, label: string,
  operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController(); let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const result = await operation(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (timedOut) throw new Error(`${label} timed out after ${timeoutMs / 1000}s.`);
    if (error instanceof WebRequestError) throw error;
    // Network exceptions can contain request headers, proxy credentials or URLs.
    // Operations use explicit safe errors for expected validation/HTTP failures.
    throw new Error(`${label} could not complete the request.`);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

/** A safe error generated locally, never an upstream body/exception. */
export class WebRequestError extends Error {}

export async function readResponseText(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  if (!response.body) throw new WebRequestError("Response body is empty.");
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body.cancel();
    throw new WebRequestError(`Response body exceeds the ${maxBytes} byte limit.`);
  }
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  const chunks: string[] = []; let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new WebRequestError(`Response body exceeds the ${maxBytes} byte limit.`); }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    signal?.throwIfAborted();
    chunks.push(decoder.decode()); return chunks.join("");
  } finally { signal?.removeEventListener("abort", abort); reader.releaseLock(); }
}
