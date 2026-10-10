import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { randomUUID } from "expo-crypto";
import { isRunActive, type Message, type RunSnapshot } from "../../../../../shared/chat";
import { cancelRun, checkHealth, isAbortError, loadConversation, streamMessage } from "./api";
import { getMainSessionId } from "./session";
import { sameMessages, syncConversation } from "./sync";
import { HttpStreamError } from "./transport";
import { applyMessageEvent, type MessageEvent } from "../../../../../shared/messages";

type Observation = {
  controller: AbortController;
  sessionId: string;
  runId: string;
  ready: boolean;
  stopRequested: boolean;
  cancelSent: boolean;
};

export function useChat() {
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [foreground, setForeground] = useState(AppState.currentState !== "background" && AppState.currentState !== "inactive");
  const foregroundRef = useRef(foreground);
  const observerRef = useRef<Observation | null>(null);
  const mounted = useRef(true);
  const refreshVersion = useRef(0);
  const pendingSubmission = useRef<RunSnapshot | null>(null);
  const sessionRef = useRef("");
  const modelReady = useRef(false);
  const syncedRun = useRef("");

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
    let historyRefresh = 0;
    let pendingEdits: MessageEvent[] | undefined;
    try {
      await streamMessage({
        sessionId: id, run, message, signal: observation.controller.signal,
        onReady: () => {
          observation.ready = true;
          if (pendingSubmission.current?.id === run.id) pendingSubmission.current = null;
          if (current()) setSubmitting(false);
          if (current()) { setConnected(true); void requestStop(observation); }
        },
        onReconnecting: (value) => { if (current()) setReconnecting(value); },
        onSnapshot: (conversation) => {
          historyRefresh++;
          pendingEdits = undefined;
          if (current()) setMessages(conversation.messages);
        },
        onEvent: (event) => {
          if (!current()) return;
          if (event.type === "message") {
            if (pendingEdits) {
              const index = pendingEdits.findIndex(edit => edit.message.id === event.message.id);
              if (index >= 0) pendingEdits[index] = event;
              else pendingEdits.push(event);
            }
            setMessages(items => applyMessageEvent(items, event));
          } else if (event.type === "refresh") {
            const version = ++historyRefresh;
            const edits: MessageEvent[] = pendingEdits = [];
            void loadConversation(id, observation.controller.signal, run.id).then(conversation => {
              if (current() && version === historyRefresh && conversation.run && isRunActive(conversation.run))
                setMessages(edits.reduce(applyMessageEvent, conversation.messages));
            }).catch(() => {}).finally(() => { if (version === historyRefresh) pendingEdits = undefined; });
          } else {
            historyRefresh++;
            if (event.type === "error") setError(event.message);
          }
        },
      });
      const conversation = await loadConversation(id, observation.controller.signal);
      if (current()) {
        setSubmitting(false);
        setMessages(conversation.messages);
        setConnected(true);
      }
    } catch (cause) {
      if (!current() || isAbortError(cause)) return;
      // A rejected input has no server Run. Release its optimistic state so idle sync can
      // discover the other channel's accepted reply instead of getting stuck behind it.
      if (cause instanceof HttpStreamError && cause.status < 500 && !observation.ready) {
        pendingSubmission.current = null;
        if (message !== undefined) setDraft(previous => previous || message);
        try {
          const conversation = await loadConversation(id, observation.controller.signal);
          if (current()) setMessages(conversation.messages);
        } catch { /* The idle observer will recover when the network is available. */ }
      }
      if (!current()) return;
      setConnected(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current()) {
        observerRef.current = null;
        setSubmitting(false);
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
      const [conversation, health] = await Promise.all([loadConversation(id, undefined, pendingSubmission.current?.id), checkHealth()]);
      if (!mounted.current || version !== refreshVersion.current) return;
      setMessages(conversation.messages);
      setConnected(health.ok && health.modelReady);
      modelReady.current = health.ok && health.modelReady;
      syncedRun.current = conversation.run ? `${conversation.run.id}:${conversation.run.status}` : "";
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
      foregroundRef.current = state === "active";
      setForeground(state === "active");
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

  useEffect(() => {
    if (!sessionId || loading || !foreground) return;
    const controller = new AbortController();
    void syncConversation({
      signal: controller.signal,
      canPoll: () => mounted.current && foregroundRef.current && !observerRef.current && !pendingSubmission.current,
      revision: () => refreshVersion.current,
      load: signal => loadConversation(sessionId, signal),
      apply: conversation => {
        const visible = conversation.messages;
        setMessages(previous => sameMessages(previous, visible) ? previous : visible);
        setConnected(modelReady.current);
        const run = conversation.run;
        const key = run ? `${run.id}:${run.status}` : "";
        if (key !== syncedRun.current) { syncedRun.current = key; setError(run?.error ?? ""); }
        if (run && isRunActive(run)) void watchRun(sessionId, run);
      },
      onError: () => { setConnected(false); },
    });
    return () => controller.abort();
  }, [foreground, loading, sessionId, watchRun]);

  const send = useCallback(async (text = draft, retryOfRunId?: string) => {
    const content = text.trim();
    if (!content || pendingSubmission.current || stopping || loading || !sessionId) return;
    refreshVersion.current++;
    const run: RunSnapshot = {
      id: randomUUID(), status: "queued", message: content, createdAt: Date.now(), lastEventId: 0,
      ...(retryOfRunId && { retryOfRunId }),
    };
    pendingSubmission.current = run;
    setSubmitting(true);
    setMessages((items) => [...items,
      { id: `user-${run.id}`, role: "user", content, createdAt: run.createdAt },
    ]);
    setDraft("");
    setError("");
    await watchRun(sessionId, run, content);
  }, [draft, loading, sessionId, stopping, watchRun]);

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
      if (conversation.run?.status === "failed" && conversation.run.message) await send(conversation.run.message, conversation.run.id);
      else await refresh(sessionId);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [busy, loading, refresh, send, sessionId]);
  const status = loading ? "Connecting…" : stopping ? "Stopping…" : reconnecting ? "Reconnecting…"
    : busy ? "Thinking…" : connected ? "Here when you need me" : "Waiting to connect";

  return { sessionId, messages, draft, setDraft, loading, busy, submitting, error, status, send, stop, retry };
}
