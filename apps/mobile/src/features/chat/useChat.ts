import { useCallback, useEffect, useRef, useState } from "react";
import { createUuidV4 } from "../../utils/uuid";
import { isRequestId } from "../../../../../shared/chat";
import type {
  ConversationResponse,
  ConversationActivity,
  HistoryPage,
  Message,
  SubmissionReceipt,
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
import { assistantLiveStatus } from "./tool-status";
import {
  useChatAttachments,
  type PendingAttachment,
} from "./useChatAttachments";

/** The owner is keyed by conversation ID and stays mounted across switches; network observation is active-only. */
export function useChat(
  conversationId?: string,
  observing = true,
  onToast?: (message: string) => void,
  onSideChatRunEnd?: (id: string, requestIds: readonly string[]) => void,
) {
  const [history, setHistory] = useState<HistoryPage>({ messages: [] });
  const [draft, setDraft] = useState("");
  const [deleted, setDeleted] = useState(false);
  const deletedRef = useRef(false);
  const messages = history.messages;
  // View identity only: preserve mounted bubbles when a live entry is committed.
  const displayKeys = useRef(new Map<string, string>());
  const messageKey = useCallback((message: Message) => message.requestId
    ? `input-${message.requestId}`
    : displayKeys.current.get(message.id) ?? message.id, []);
  const historyRef = useRef(history);
  historyRef.current = history;
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState("");
  const olderController = useRef<AbortController | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<ConversationActivity>({ kind: "idle" });
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
    if (!mounted.current || deletedRef.current) return;
    for (const [id, previous] of Object.entries(snapshot.previousIds ?? {}))
      displayKeys.current.set(id, displayKeys.current.get(previous) ?? previous);
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
    setActivity(snapshot.activity);
    setLoading(false);
    setError(
      snapshot.latest?.status === "unanswered" &&
        snapshot.latest.error !== "aborted"
        ? (snapshot.latest.error ?? "回复失败。")
        : (snapshot.interruption ?? ""),
    );
  }, []);
  const onMessage = useCallback(
    (event: Extract<StreamEvent, { type: "message" }>) => {
      if (deletedRef.current) return;
      if (event.previousId)
        displayKeys.current.set(event.message.id, displayKeys.current.get(event.previousId) ?? event.previousId);
      setHistory((current) => ({
        ...current,
        messages: applyMessageEvent(current.messages, event),
      }));
    },
    [],
  );
  const onRunEnd = useCallback((submissions: readonly SubmissionReceipt[]) => {
    if (!conversationId || deletedRef.current) return;
    const requestIds = submissions
      .filter(item => item.status === "done" && isRequestId(item.requestId))
      .map(item => item.requestId!);
    if (requestIds.length) onSideChatRunEnd?.(conversationId, requestIds);
  }, [conversationId, onSideChatRunEnd]);
  const { attachments, setAttachments, attaching, attach, removeAttachment } =
    useChatAttachments(loading, sending, mounted, setError);
  const onDeleted = useCallback(() => {
    deletedRef.current = true;
    pending.current = null;
    submitController.current?.abort();
    olderController.current?.abort();
    setHistory({ messages: [] });
    setActivity({ kind: "idle" });
    setDraft("");
    setAttachments([]);
    setBusy(false);
    setLoading(false);
    setDeleted(true);
  }, [setAttachments]);
  const {
    connected,
    reconnecting,
    version: observedVersion,
  } = useConversationObservation(
    conversationId,
    observing && !deleted,
    apply,
    onMessage,
    setActivity,
    onRunEnd,
    setError,
    onDeleted,
  );
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
      if (deletedRef.current || !before || olderController.current || loading) return;
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
        if (!mounted.current || deletedRef.current || controller.signal.aborted) return;
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
              : "无法加载更早的消息。",
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
              id: createUuidV4(),
              message: content,
              createdAt: Date.now(),
              attachments,
            };
      if (
        deletedRef.current ||
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
        const modelSetupError = cause instanceof HttpStreamError && cause.status === 409 &&
          (cause.message.startsWith("尚未选择主模型") || cause.message.startsWith("主模型当前不可用"));
        if (modelSetupError) {
          onToast?.(cause.message);
          setError("");
        } else {
          setError(cause instanceof Error ? cause.message : "发送失败。");
        }
      } finally {
        sending.current = false;
        if (mounted.current) setSubmitting(false);
      }
    },
    [draft, stopping, loading, refresh, attachments, attaching, conversationId, onToast],
  );
  const stop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    stopId.current ??= createUuidV4();
    try {
      await stopConversation(stopId.current, conversationId);
      stopId.current = undefined;
      await refresh();
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "停止失败。",
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
  const busyStatus = assistantLiveStatus(activity);
  const status = loading
    ? "连接中…"
    : attaching
      ? "正在上传…"
      : stopping
        ? "正在停止…"
        : reconnecting
          ? "正在重连…"
          : busy
            ? busyStatus
            : connected
              ? ""
              : "等待连接";
  return {
    deleted,
    messages,
    messageKey,
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
