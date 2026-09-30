import type { StreamEvent } from "../../shared/chat";
import { encodeSse } from "../../shared/sse";
import type { ChatSession } from "../runtime/types";
import type { ConversationStore } from "./conversations";

export function chatStream(conversations: ConversationStore, request: Request, sessionId: string, prompt: string): Response {
  let activeSession: ChatSession | undefined;
  let cancelled = request.signal.aborted;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let unsubscribe: (() => void) | undefined;
  const encoder = new TextEncoder();
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    unsubscribe?.();
    if (activeSession?.isStreaming) void activeSession.abort().catch(() => { });
    request.signal.removeEventListener("abort", cancel);
    try { streamController?.close(); } catch { /* Stream cancellation already closed the controller. */ }
  };

  if (!cancelled) request.signal.addEventListener("abort", cancel, { once: true });

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (cancelled) { controller.close(); return; }
      const send = (event: StreamEvent) => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(encodeSse(event)));
        } catch {
          cancel();
        }
      };

      void (async () => {
        try {
          const conversation = await conversations.get(sessionId);
          if (cancelled) return;
          if (conversation.session.isStreaming) throw new Error("This conversation is already responding.");
          activeSession = conversation.session;
          conversation.touchedAt = Date.now();

          let agentError: string | undefined;
          unsubscribe = activeSession.subscribe((event) => {
            if (event.type === "delta") send(event);
            else if (event.type === "error") agentError = event.message;
          });

          await activeSession.prompt(prompt);
          if (agentError) send({ type: "error", message: agentError });
          else send({ type: "done" });
          conversation.touchedAt = Date.now();
        } catch (error) {
          send({ type: "error", message: error instanceof Error ? error.message : "Pi could not complete this reply." });
        } finally {
          unsubscribe?.();
          unsubscribe = undefined;
          request.signal.removeEventListener("abort", cancel);
          if (!cancelled) {
            try {
              controller.close();
            } catch {
              // The client may have closed the stream first.
            }
          }
        }
      })();
    },
    cancel() {
      cancel();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
