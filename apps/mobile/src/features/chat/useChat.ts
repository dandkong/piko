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
import { ApiError, errorMessage } from "../../api/errors";
import { useTranslation } from "../../i18n";

type OperationError = { kind: "send" | "stop" | "upload" | "refresh"; message: string };
type ExecutionNotice = { key: string; message: string; tone: "error" | "info" };
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
  const { t, language } = useTranslation();
  const translateRef = useRef(t);
  translateRef.current = t;
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
  const [retrying, setRetrying] = useState(false);
  const checking = useRef(false);
  const [operationError, setOperationError] = useState<OperationError>();
  const [executionNotice, setExecutionNotice] = useState<ExecutionNotice>();
  const dismissedExecution = useRef("");
  const mounted = useRef(true);
  const pending = useRef<{
    id: string;
    message: string;
    createdAt: number;
    attachments: PendingAttachment[];
  } | null>(null);
  const sending = useRef(false);
  const submitController = useRef<AbortController | undefined>(undefined);
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
                ...(remaining.attachments.length && { attachments: remaining.attachments }),
              },
            ],
          }
        : next;
    });
    setBusy(snapshot.busy);
    setActivity(snapshot.activity);
    setLoading(false);
    setOperationError(current => current?.kind === "refresh" || current?.kind === "send" && input && !remaining ? undefined : current);
    const failed = snapshot.latest?.status === "unanswered" && snapshot.latest.error !== "aborted";
    const key = failed ? `failed:${snapshot.latest?.id}` : snapshot.interruption ? `interrupted:${snapshot.latest?.id ?? ""}` : "";
    setExecutionNotice(!key || key === dismissedExecution.current ? undefined : {
      key, tone: failed ? "error" : "info",
      message: translateRef.current(failed ? "chat.replyFailed" : "chat.interrupted"),
    });
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
  const onAttachmentError = useCallback((message: string) => {
    setOperationError(current => message ? { kind: "upload", message } : current?.kind === "upload" ? undefined : current);
  }, []);
  const onObservationError = useCallback((_message: string) => {
    setLoading(false);
    setOperationError(current => current && current.kind !== "refresh" ? current
      : { kind: "refresh", message: translateRef.current("chat.refreshFailed") });
  }, []);
  const { attachments, setAttachments, attaching, attach, pasteFiles, retryUpload, removeAttachment } =
    useChatAttachments(loading, sending, mounted, onAttachmentError);
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
    setOperationError(undefined);
    setExecutionNotice(undefined);
    setDeleted(true);
  }, [setAttachments]);
  const {
    connected,
    reconnecting,
    modelReady,
    version: observedVersion,
  } = useConversationObservation(
    conversationId,
    observing && !deleted,
    apply,
    onMessage,
    setActivity,
    onRunEnd,
    onObservationError,
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
          setOlderError(errorMessage(cause, translateRef.current("chat.olderLoadFailed"), translateRef.current));
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
      if (!retry && pending.current) {
        setOperationError({ kind: "send", message: translateRef.current("chat.pendingSend") });
        return;
      }
      pending.current = input;
      sending.current = true;
      setSubmitting(true);
      if (!retry) { setDraft(""); setAttachments([]); }
      setOperationError(undefined);
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
      let accepted = false;
      try {
        await submit(
          input.message,
          input.id,
          controller.signal,
          input.attachments.map((item) => item.id),
          conversationId,
        );
        accepted = true;
        if (pending.current?.id === input.id) pending.current = null;
        if (mounted.current) await refresh();
      } catch (cause) {
        if (!mounted.current || controller.signal.aborted) return;
        if (accepted) {
          setOperationError({ kind: "refresh", message: translateRef.current("chat.acceptedRefreshFailed") });
          return;
        }
        if (!pending.current) return; // SSE already confirmed the same submission.
        if (cause instanceof ApiError && cause.status < 500) {
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
        if (cause instanceof ApiError && cause.code === "model_unavailable") {
          onToast?.(cause.message);
          setOperationError(undefined);
        } else {
          setOperationError({ kind: "send", message: errorMessage(cause,
            translateRef.current("chat.sendUnconfirmed"), translateRef.current) });
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
    setOperationError(current => current?.kind === "stop" ? undefined : current);
    stopId.current ??= createUuidV4();
    let accepted = false;
    try {
      await stopConversation(stopId.current, conversationId);
      accepted = true;
      stopId.current = undefined;
      await refresh();
    } catch (cause) {
      if (mounted.current)
        setOperationError({ kind: accepted ? "refresh" : "stop", message: accepted
          ? translateRef.current("chat.stoppedRefreshFailed")
          : errorMessage(cause, translateRef.current("chat.stopUnconfirmed"), translateRef.current) });
    } finally {
      if (mounted.current) setStopping(false);
    }
  }, [stopping, refresh, conversationId]);
  const retry = useCallback(async () => {
    if (submitting || stopping || attaching || checking.current) return;
    checking.current = true;
    setRetrying(true);
    try {
      if (operationError?.kind === "stop") { await stop(); return; }
      if (operationError?.kind === "upload") { await retryUpload(); return; }
      if (operationError?.kind === "send" && !pending.current) { setOperationError(undefined); return; }
      await refresh();
      if (operationError?.kind === "send" && pending.current) await send(pending.current.message, true);
    } catch (cause) {
      setOperationError({ kind: operationError?.kind === "send" ? "send" : "refresh",
        message: errorMessage(cause, translateRef.current("chat.checkFailed"), translateRef.current) });
    } finally {
      checking.current = false;
      if (mounted.current) setRetrying(false);
    }
  }, [operationError?.kind, send, stop, retryUpload, refresh, submitting, stopping, attaching]);
  const dismissError = useCallback(() => {
    setOperationError(undefined);
    if (executionNotice) dismissedExecution.current = executionNotice.key;
    setExecutionNotice(undefined);
  }, [executionNotice]);
  const error = operationError?.message ?? executionNotice?.message ?? "";
  const retryLabel = t(operationError?.kind === "stop" ? "chat.retryStop"
    : operationError?.kind === "upload" ? "chat.retryUpload" : operationError?.kind === "send"
      ? pending.current ? "chat.retrySend" : "chat.continueEditing" : "chat.reload");
  const busyStatus = assistantLiveStatus(activity, language);
  const status = loading
    ? t("chat.statusConnecting")
    : attaching
      ? t("chat.uploading")
      : stopping
        ? t("chat.stopping")
        : reconnecting
          ? t("chat.reconnecting")
          : busy
            ? busyStatus
            : connected
              ? modelReady ? "" : t("chat.noModel")
              : t("chat.waiting");
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
    errorTone: operationError ? "error" as const : executionNotice?.tone ?? "error" as const,
    retryLabel,
    retryBusy: retrying || submitting || stopping || attaching,
    dismissError,
    status,
    send,
    stop,
    retry,
    attachments,
    attach,
    pasteFiles,
    removeAttachment,
    attaching,
    hasOlder: !!history.nextBefore,
    loadingOlder,
    olderError,
    loadOlder,
  };
}
