import { useCallback, useEffect, useRef, useState } from "react";
import type { Message, StreamEvent } from "../../../../../shared/chat";
import { checkHealth, isAbortError, loadConversation, streamMessage } from "./api";
import { getOrCreateSessionId } from "./session";

export function useChat() {
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    let active = true;
    mounted.current = true;
    void (async () => {
      try {
        const id = await getOrCreateSessionId();
        if (!active) return;
        setSessionId(id);
        const [history, health] = await Promise.all([loadConversation(id), checkHealth()]);
        if (!active) return;
        setMessages(history);
        setConnected(health.ok && health.modelReady);
        if (!health.modelReady) setError("Piko is running, but no model is configured yet.");
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      mounted.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const send = useCallback(
    async (text = draft) => {
      const content = text.trim();
      if (!content || abortRef.current || busy || loading || !sessionId) return;

      const userMessage: Message = {
        id: `user-${Date.now()}`, role: "user", content, createdAt: Date.now(),
      };
      const assistantId = `assistant-${Date.now()}`;
      setMessages((current) => [
        ...current, userMessage,
        { id: assistantId, role: "assistant", content: "", createdAt: Date.now() },
      ]);
      setDraft("");
      setBusy(true);
      setError("");
      const controller = new AbortController();
      abortRef.current = controller;
      let receivedStreamError = false;

      const handleEvent = (event: StreamEvent) => {
        if (!mounted.current) return;
        if (event.type === "delta") {
          setConnected(true);
          setMessages((current) =>
            current.map((item) =>
              item.id === assistantId ? { ...item, content: item.content + event.text } : item,
            ),
          );
        } else if (event.type === "error") {
          receivedStreamError = true;
          setError(event.message);
        }
      };

      try {
        await streamMessage(sessionId, content, controller.signal, handleEvent);
        const history = await loadConversation(sessionId);
        if (mounted.current && !receivedStreamError) {
          setMessages(history);
          setConnected(true);
        }
      } catch (cause) {
        if (!mounted.current) return;
        if (!isAbortError(cause)) {
          setConnected(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        setMessages((current) => current.filter((item) => item.id !== assistantId || item.content));
      } finally {
        abortRef.current = null;
        if (mounted.current) setBusy(false);
      }
    },
    [busy, draft, loading, sessionId],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const retry = useCallback(() => {
    const lastUserMessage = [...messages].reverse().find((item) => item.role === "user");
    if (lastUserMessage) void send(lastUserMessage.content);
  }, [messages, send]);
  const status = loading ? "Connecting…" : busy ? "Thinking…" : connected ? "Here when you need me" : "Waiting to connect";

  return { sessionId, messages, draft, setDraft, loading, busy, error, status, send, stop, retry };
}
