import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { randomUUID } from "expo-crypto";
import { isRunActive, type ConversationResponse, type Message, type RunSnapshot } from "../../../../../shared/chat";
import { cancelRun, checkHealth, isAbortError, loadConversation, streamMessage } from "./api";
import { getMainSessionId } from "./session";

type Observation = {
  controller: AbortController;
  sessionId: string;
  runId: string;
  ready: boolean;
  stopRequested: boolean;
  cancelSent: boolean;
};

function visibleMessages(conversation: ConversationResponse): Message[] {
  const run = conversation.run;
  return run && isRunActive(run) ? [...conversation.messages, {
    id: `assistant-${run.id}`, role: "assistant", content: run.text, createdAt: run.createdAt,
  }] : conversation.messages;
}

export function useChat() {
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const observerRef = useRef<Observation | null>(null);
  const mounted = useRef(true);
  const refreshVersion = useRef(0);
  const pendingSubmission = useRef<RunSnapshot | null>(null);
  const sessionRef = useRef("");

  const requestStop = useCallback(async (observation: Observation) => {
    if (!observation.ready || observation.cancelSent || !observation.stopRequested) return;
    observation.cancelSent = true;
    try {
      await cancelRun(observation.sessionId, observation.runId);
    } catch (cause) {
      if (!mounted.current || observerRef.current !== observation) return;
      observation.cancelSent = false;
      observation.stopRequested = false;
      setStopping(false);
      setError(cause instanceof Error ? cause.message : "Could not stop this reply.");
    }
  }, []);

  const watchRun = useCallback(async (id: string, run: RunSnapshot, message?: string) => {
    observerRef.current?.controller.abort();
    const observation: Observation = {
      controller: new AbortController(), sessionId: id, runId: run.id,
      ready: message === undefined, stopRequested: run.status === "cancelling", cancelSent: false,
    };
    observerRef.current = observation;
    const current = () => mounted.current && observerRef.current === observation;
    setBusy(true);
    setStopping(run.status === "cancelling");
    setReconnecting(false);
    let text = run.text;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(flushTimer);
      flushTimer = undefined;
      if (current()) setMessages((items) => items.map((item) =>
        item.id === `assistant-${run.id}` ? { ...item, content: text } : item));
    };
    try {
      await streamMessage({
        sessionId: id, run, message, signal: observation.controller.signal,
        onReady: () => {
          observation.ready = true;
          if (pendingSubmission.current?.id === run.id) pendingSubmission.current = null;
          if (current()) { setConnected(true); void requestStop(observation); }
        },
        onReconnecting: (value) => { if (current()) setReconnecting(value); },
        onSnapshot: (conversation) => {
          clearTimeout(flushTimer);
          flushTimer = undefined;
          text = conversation.run!.text;
          if (current()) setMessages(visibleMessages(conversation));
        },
        onEvent: (event) => {
          if (!current()) return;
          if (event.type === "delta") {
            text += event.text;
            if (!flushTimer) flushTimer = setTimeout(flush, 50);
          } else {
            flush();
            if (event.type === "error") setError(event.message);
          }
        },
      });
      flush();
      const conversation = await loadConversation(id, observation.controller.signal);
      if (current()) {
        setMessages(visibleMessages(conversation));
        setConnected(true);
      }
    } catch (cause) {
      flush();
      if (!current() || isAbortError(cause)) return;
      setConnected(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      clearTimeout(flushTimer);
      if (current()) {
        observerRef.current = null;
        setBusy(false);
        setStopping(false);
        setReconnecting(false);
      }
    }
  }, [requestStop]);

  const refresh = useCallback(async (id: string) => {
    const version = ++refreshVersion.current;
    observerRef.current?.controller.abort();
    observerRef.current = null;
    setLoading(true);
    setBusy(false);
    try {
      const [conversation, health] = await Promise.all([loadConversation(id), checkHealth()]);
      if (!mounted.current || version !== refreshVersion.current) return;
      setMessages(visibleMessages(conversation));
      setConnected(health.ok && health.modelReady);
      setError(health.modelReady ? conversation.run?.error ?? "" : "Piko is running, but no model is configured yet.");
      setReconnecting(false);
      setStopping(false);
      if (conversation.run && isRunActive(conversation.run)) {
        pendingSubmission.current = null;
        void watchRun(id, conversation.run);
      } else if (pendingSubmission.current && conversation.run?.id !== pendingSubmission.current.id) {
        const pending = pendingSubmission.current;
        setMessages([...conversation.messages,
          { id: `user-${pending.id}`, role: "user", content: pending.message, createdAt: pending.createdAt },
          { id: `assistant-${pending.id}`, role: "assistant", content: "", createdAt: pending.createdAt },
        ]);
        void watchRun(id, pending, pending.message);
      } else pendingSubmission.current = null;
    } catch (cause) {
      if (!mounted.current || version !== refreshVersion.current) return;
      setConnected(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current && version === refreshVersion.current) setLoading(false);
    }
  }, [watchRun]);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    void (async () => {
      try {
        const id = await getMainSessionId();
        if (!active) return;
        sessionRef.current = id;
        setSessionId(id);
        await refresh(id);
      } catch (cause) {
        if (active) { setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false); }
      }
    })();
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && previousState !== "active" && sessionRef.current) void refresh(sessionRef.current);
      previousState = state;
    });
    return () => {
      active = false;
      mounted.current = false;
      refreshVersion.current++;
      subscription.remove();
      observerRef.current?.controller.abort();
      observerRef.current = null;
    };
  }, [refresh]);

  const send = useCallback(async (text = draft, retryOfRunId?: string) => {
    const content = text.trim();
    if (!content || observerRef.current || busy || loading || !sessionId) return;
    refreshVersion.current++;
    const run: RunSnapshot = {
      id: randomUUID(), status: "queued", message: content, text: "", createdAt: Date.now(), lastEventId: 0,
      ...(retryOfRunId && { retryOfRunId }),
    };
    pendingSubmission.current = run;
    setMessages((items) => [...items,
      { id: `user-${run.id}`, role: "user", content, createdAt: run.createdAt },
      { id: `assistant-${run.id}`, role: "assistant", content: "", createdAt: run.createdAt },
    ]);
    setDraft("");
    setError("");
    await watchRun(sessionId, run, content);
  }, [busy, draft, loading, sessionId, watchRun]);

  const stop = useCallback(() => {
    const observation = observerRef.current;
    if (!observation) return;
    observation.stopRequested = true;
    setStopping(true);
    void requestStop(observation);
  }, [requestStop]);
  const retry = useCallback(async () => {
    if (busy || loading) return;
    try {
      if (!sessionId) {
        const id = await getMainSessionId();
        if (!mounted.current) return;
        sessionRef.current = id;
        setSessionId(id);
        await refresh(id);
        return;
      }
      const conversation = await loadConversation(sessionId);
      if (!mounted.current) return;
      if (conversation.run?.status === "failed") await send(conversation.run.message, conversation.run.id);
      else await refresh(sessionId);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [busy, loading, refresh, send, sessionId]);
  const status = loading ? "Connecting…" : stopping ? "Stopping…" : reconnecting ? "Reconnecting…"
    : busy ? "Thinking…" : connected ? "Here when you need me" : "Waiting to connect";

  return { sessionId, messages, draft, setDraft, loading, busy, error, status, send, stop, retry };
}
