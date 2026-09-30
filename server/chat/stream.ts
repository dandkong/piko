import { encodeSse } from "../../shared/sse";
import type { ChatRun } from "./run";

/** Disconnecting removes only this observer; cancellation is an explicit Run operation. */
export function chatStream(run: ChatRun, request: Request, after = 0): Response {
  let cleanup = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        clearInterval(heartbeat);
        request.signal.removeEventListener("abort", close);
        try { controller.close(); } catch { /* The reader may already have cancelled. */ }
      };
      cleanup = close;
      if (request.signal.aborted) { close(); return; }
      request.signal.addEventListener("abort", close, { once: true });
      unsubscribe = run.subscribe(after, (event) => {
        if (closed) return;
        try {
          // A slow observer can recover from the Run snapshot rather than buffer without limit.
          if ((controller.desiredSize ?? 0) <= 0) { close(); return; }
          controller.enqueue(encoder.encode(encodeSse(event)));
          if (event.type !== "delta") close();
        } catch { close(); }
      });
      if (closed) { unsubscribe(); return; }
      if (!run.active) { close(); return; }
      heartbeat = setInterval(() => {
        try {
          if ((controller.desiredSize ?? 0) <= 0) { close(); return; }
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch { close(); }
      }, 15_000);
    },
    cancel() { cleanup(); },
  }, { highWaterMark: 256 * 1024, size: (chunk) => chunk?.byteLength ?? 0 });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
