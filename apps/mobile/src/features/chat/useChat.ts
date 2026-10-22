import { useCallback, useEffect, useRef, useState } from "react";
import { randomUUID } from "expo-crypto";
import type {
  ConversationResponse,
  HistoryPage,
  StreamEvent,
} from "../../../../../shared/chat";
import {
  isAbortError,
  loadConversation,
  loadHistory,
  submit,
  stopConversation,
} from "./api";
import {
  mergeHistorySnapshot,
  prependHistoryPage,
} from "../../../../../shared/history";
import { applyMessageEvent } from "../../../../../shared/messages";
import { HttpStreamError } from "./transport";
import { useConversationObservation } from "./useConversationObservation";
import {
  useChatAttachments,
  type PendingAttachment,
} from "./useChatAttachments";

/** The owner is keyed by conversation ID and stays mounted across switches; network observation is active-only. */
export function useChat(conversationId?: string, observing = true) {
  const [history, setHistory] = useState<HistoryPage>({ messages: [] });
  const [draft, setDraft] = useState("");
  const messages = history.messages;
  const historyRef = useRef(history);
  historyRef.current = history;
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState("");
  const olderController = useRef<AbortController | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const pending = useRef<{
    id: string;
    message: string;
    createdAt: number;
    attachments: PendingAttachment[];
  } | null>(null);
  const sending = useRef(false);
  const submitController = useRef<AbortController | undefined>(undefined);
  const lastMessage = useRef("");
  const stopId = useRef<string | undefined>(undefined);
  const apply = useCallback((snapshot: ConversationResponse) => {
    if (!mounted.current) return;
    const input = pending.current;
    if (
      input &&
      (snapshot.messages.some((item) => item.requestId === input.id) ||
        (snapshot.latest?.requestId === input.id &&
          snapshot.latest.status !== "queued"))
    )
      pending.current = null;
    const remaining = pending.current;
    setHistory((current) => {
      const next = mergeHistorySnapshot(current, snapshot);
      return remaining
        ? {
            ...next,
            messages: [
              ...next.messages,
              {
                id: `input-${remaining.id}`,
                role: "user",
                content: remaining.message,
                createdAt: remaining.createdAt,
                requestId: remaining.id,
              },
            ],
          }
        : next;
    });
    setBusy(snapshot.busy);
    setLoading(false);
    setError(
      snapshot.latest?.status === "unanswered" &&
        snapshot.latest.error !== "aborted"
        ? (snapshot.latest.error ?? "Reply failed.")
        : (snapshot.interruption ?? ""),
    );
  }, []);
  const onMessage = useCallback(
    (event: Extract<StreamEvent, { type: "message" }>) => {
      setHistory((current) => ({
        ...current,
        messages: applyMessageEvent(current.messages, event),
      }));
    },
    [],
  );
  const {
    connected,
    reconnecting,
    modelReady,
    version: observedVersion,
  } = useConversationObservation(
    conversationId,
    observing,
    apply,
    onMessage,
    setError,
  );
  const { attachments, setAttachments, attaching, attach, removeAttachment } =
    useChatAttachments(loading, sending, mounted, setError);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      submitController.current?.abort();
      olderController.current?.abort();
    };
  }, []);
  const refresh = useCallback(async () => {
    const version = observedVersion.current;
    const snapshot = await loadConversation(undefined, conversationId);
    if (version === observedVersion.current) apply(snapshot);
  }, [apply, conversationId]);
  const loadOlder = useCallback(
    async (beforePrepend?: () => void) => {
      const before = historyRef.current.nextBefore;
      if (!before || olderController.current || loading) return;
      const controller = new AbortController();
      olderController.current = controller;
      setLoadingOlder(true);
      setOlderError("");
      try {
        const page = await loadHistory(
          before,
          controller.signal,
          conversationId,
        );
        if (!mounted.current || controller.signal.aborted) return;
        if (historyRef.current.nextBefore === before && page.messages.length)
          beforePrepend?.();
        setHistory((current) => prependHistoryPage(current, page, before));
      } catch (cause) {
        if (
          mounted.current &&
          !isAbortError(cause) &&
          historyRef.current.nextBefore === before
        )
          setOlderError(
            cause instanceof Error
              ? cause.message
              : "Couldn't load earlier messages.",
          );
      } finally {
        olderController.current = undefined;
        if (mounted.current) setLoadingOlder(false);
      }
    },
    [loading, conversationId],
  );
  const send = useCallback(
    async (text = draft, retry = false) => {
      const content = text.trim();
      const input =
        retry && pending.current
          ? pending.current
          : {
              id: randomUUID(),
              message: content,
              createdAt: Date.now(),
              attachments,
            };
      if (
        (!input.message && !input.attachments.length) ||
        sending.current ||
        stopping ||
        loading ||
        attaching
      )
        return;
      pending.current = input;
      lastMessage.current = input.message;
      sending.current = true;
      setSubmitting(true);
      setDraft("");
      setAttachments([]);
      setError("");
      setHistory((current) => ({
        ...current,
        messages: [
          ...current.messages.filter((item) => item.requestId !== input.id),
          {
            id: `input-${input.id}`,
            role: "user",
            content: input.message,
            createdAt: input.createdAt,
            requestId: input.id,
            ...(input.attachments.length && { attachments: input.attachments }),
          },
        ],
      }));
      const controller = new AbortController();
      submitController.current = controller;
      try {
        await submit(
          input.message,
          input.id,
          controller.signal,
          input.attachments.map((item) => item.id),
          conversationId,
        );
        if (mounted.current) await refresh();
      } catch (cause) {
        if (!mounted.current || isAbortError(cause)) return;
        if (cause instanceof HttpStreamError && cause.status < 500) {
          pending.current = null;
          setDraft(input.message);
          setAttachments(input.attachments);
          setHistory((current) => ({
            ...current,
            messages: current.messages.filter(
              (item) => item.requestId !== input.id,
            ),
          }));
        }
        setError(
          cause instanceof Error ? cause.message : "Couldn't send message.",
        );
      } finally {
        sending.current = false;
        if (mounted.current) setSubmitting(false);
      }
    },
    [draft, stopping, loading, refresh, attachments, attaching, conversationId],
  );
  const stop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    stopId.current ??= randomUUID();
    try {
      await stopConversation(stopId.current, conversationId);
      stopId.current = undefined;
      await refresh();
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "Couldn't stop reply.",
        );
    } finally {
      if (mounted.current) setStopping(false);
    }
  }, [stopping, refresh, conversationId]);
  const retry = useCallback(async () => {
    if (submitting || stopping) return;
    if (pending.current) await send(pending.current.message, true);
    else if (lastMessage.current && error && !busy)
      await send(lastMessage.current);
    else {
      try {
        await refresh();
      } catch (cause) {
        setError(String(cause));
      }
    }
  }, [send, refresh, submitting, stopping, busy, error]);
  const status = loading
    ? "Connecting…"
    : attaching
      ? "Uploading…"
      : stopping
        ? "Stopping…"
        : reconnecting
          ? "Reconnecting…"
          : busy
            ? "Thinking…"
            : connected
              ? ""
              : "Waiting to connect";
  return {
    ready: !loading && modelReady,
    messages,
    draft,
    setDraft,
    loading,
    busy,
    submitting,
    error,
    status,
    send,
    stop,
    retry,
    attachments,
    attach,
    removeAttachment,
    attaching,
    hasOlder: !!history.nextBefore,
    loadingOlder,
    olderError,
    loadOlder,
  };
}
