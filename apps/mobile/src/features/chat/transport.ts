import { consumeSse } from "../../../../../shared/sse";
import type { StreamEvent } from "../../../../../shared/chat";
export class HttpStreamError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}
/** Persistent conversation observation; no input is ever posted by reconnect logic. */
export async function observeConversation(options: { signal: AbortSignal; onEvent: (event: StreamEvent) => void; onReconnecting: (value: boolean) => void },
  transport: { fetch: (path: string, init?: RequestInit) => Promise<Response>; wait?: typeof waitForRetry }, path = "/api/chat") {
  let failures = 0;
  const wait = transport.wait ?? waitForRetry;
  while (!options.signal.aborted) {
    const controller = new AbortController(); const abort = () => controller.abort();
    options.signal.addEventListener("abort", abort, { once: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let watchdog: ReturnType<typeof setTimeout>;
    const touch = () => { clearTimeout(watchdog); watchdog = setTimeout(abort, 30000); };
    try {
      touch();
      const response = await transport.fetch(`${path}/events`, { signal: controller.signal });
      if (response.status === 404 && path.startsWith("/api/side-chats/")) { options.onEvent({ type: "deleted" }); return; }
      if (!response.ok) throw new HttpStreamError("无法接收对话内容。", response.status);
      if (!response.body) throw new Error("流式响应不可用。");
      reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      while (!options.signal.aborted) {
        const chunk = await reader.read(); if (chunk.done) break; touch();
        options.onReconnecting(false); failures = 0;
        buffer += decoder.decode(chunk.value, { stream: true });
        const parsed = consumeSse(buffer); buffer = parsed.remainder;
        for (const event of parsed.events) {
          options.onEvent(event);
          if (event.type === "deleted") return;
        }
      }
      if (options.signal.aborted) return;
      throw new Error("对话连接已断开。");
    } catch {
      if (options.signal.aborted) return;
      options.onReconnecting(true);
    } finally { clearTimeout(watchdog!); controller.abort(); await reader?.cancel().catch(() => {}); options.signal.removeEventListener("abort", abort); }
    try { await wait(Math.min(10000, 500 * 2 ** Math.min(failures++, 5)), options.signal); } catch { return; }
  }
}
/** Unknown acknowledgements retry the same request; a new ID is only for a new user action. */
export async function submitMessage(message: string, requestId: string, signal: AbortSignal,
  transport: { fetch: (path: string, init?: RequestInit) => Promise<Response>; wait?: typeof waitForRetry },
  attachmentIds?: string[], path = "/api/chat") {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController(); const abort = () => controller.abort();
    const timer = setTimeout(abort, 10000); signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const response = await transport.fetch(path, { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, message, ...(attachmentIds?.length && { attachmentIds }) }) });
      const result = await response.json();
      if (!response.ok) throw new HttpStreamError(result.error ?? "发送失败。", response.status);
      return result;
    } catch (error) {
      if (signal.aborted || error instanceof HttpStreamError && error.status < 500 || attempt >= 2) throw error;
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
    await (transport.wait ?? waitForRetry)(500 * 2 ** attempt, signal);
  }
}
