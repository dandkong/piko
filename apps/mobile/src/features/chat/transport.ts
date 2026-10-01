import { isRunActive, type ConversationResponse, type RunSnapshot, type StreamEvent } from "../../../../../shared/chat";
import { consumeSse } from "../../../../../shared/sse";

type Transport = {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  load: (sessionId: string, signal: AbortSignal) => Promise<ConversationResponse>;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};
type Observer = {
  sessionId: string;
  run: RunSnapshot;
  message?: string;
  signal: AbortSignal;
  onEvent: (event: StreamEvent) => void;
  onSnapshot: (conversation: ConversationResponse) => void;
  onReady: () => void;
  onReconnecting: (reconnecting: boolean) => void;
};

class HttpStreamError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function abortError(): Error { return Object.assign(new Error("Request aborted."), { name: "AbortError" }); }

export function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Reconnect the same Run; replay cursors and snapshots prevent duplicate text or prompts. */
export async function observeRun(observer: Observer, transport: Transport): Promise<void> {
  const { sessionId, run, signal, onEvent, onSnapshot, onReady, onReconnecting } = observer;
  let cursor = run.lastEventId;
  let accepted = observer.message === undefined;
  let failures = 0;
  if (signal.aborted) throw abortError();
  const loadSnapshot = async () => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15_000);
    try { return await transport.load(sessionId, controller.signal); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  };
  const terminalSnapshot = (snapshot: RunSnapshot) => {
    if (isRunActive(snapshot)) return false;
    onEvent(snapshot.status === "failed" ? { type: "error", message: snapshot.error ?? "Reply failed." }
      : snapshot.status === "cancelled" ? { type: "cancelled" } : { type: "done" });
    return true;
  };
  if (terminalSnapshot(run)) return;

  while (!signal.aborted) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    let watchdog: ReturnType<typeof setTimeout>;
    const resetWatchdog = () => { clearTimeout(watchdog); watchdog = setTimeout(abort, 45_000); };
    resetWatchdog();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await transport.fetch(accepted
        ? `/api/sessions/${sessionId}/runs/${run.id}/events?after=${cursor}` : "/api/chat", accepted
        ? { signal: controller.signal, headers: { Accept: "text/event-stream" } }
        : {
          method: "POST", signal: controller.signal,
          headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, runId: run.id, message: observer.message, after: cursor, retryOfRunId: run.retryOfRunId }),
        });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new HttpStreamError(response.status, payload?.error ?? `Request failed (${response.status}).`);
      }
      accepted = true;
      onReady();
      if (!response.body) throw new Error("This runtime did not provide a streaming response body.");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) throw new Error("Reply stream ended before completion.");
        resetWatchdog();
        pending += decoder.decode(value, { stream: true });
        const parsed = consumeSse(pending);
        pending = parsed.remainder;
        for (const event of parsed.events) {
          if (event.runId !== run.id || event.sequence === undefined) throw new Error("Invalid reply event.");
          if (event.sequence <= cursor) continue;
          if (event.sequence !== cursor + 1) throw new Error("Reply event gap. Reloading progress.");
          cursor = event.sequence;
          failures = 0;
          onReconnecting(false);
          onEvent(event);
          if (event.type !== "delta") return;
        }
      }
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (error instanceof HttpStreamError && error.status !== 409 && error.status < 500) throw error;
      if (++failures > 5) throw new Error("Connection interrupted. Return to the conversation to reconnect; the reply may still be running.");
      // Release the old connection before querying progress or waiting to reconnect.
      controller.abort();
      clearTimeout(watchdog!);
      onReconnecting(true);
      try {
        const snapshot = await loadSnapshot();
        if (snapshot.run?.id === run.id) {
          if (snapshot.run.message !== run.message) throw new HttpStreamError(409, "This runId belongs to another message.");
          accepted = true;
          cursor = snapshot.run.lastEventId;
          onSnapshot(snapshot);
          onReady();
          if (terminalSnapshot(snapshot.run)) { onReconnecting(false); return; }
        } else if (error instanceof HttpStreamError && error.status === 409) {
          throw error;
        } else if (accepted || (snapshot.run && isRunActive(snapshot.run))) {
          throw new HttpStreamError(404, "This reply is no longer available. Reload the conversation.");
        }
      } catch (recoveryError) {
        if (signal.aborted) throw abortError();
        if (recoveryError instanceof HttpStreamError) throw recoveryError;
        if (error instanceof HttpStreamError && error.status === 409) throw error;
      }
      await (transport.wait ?? waitForRetry)(Math.min(400 * 2 ** (failures - 1), 4000), signal);
    } finally {
      controller.abort();
      clearTimeout(watchdog!);
      signal.removeEventListener("abort", abort);
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }
  throw abortError();
}
