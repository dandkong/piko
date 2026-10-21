import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { getRandomBytes } from "expo-crypto";
import { MAX_ATTACHMENTS, type ConversationResponse, type HistoryPage, type MessageAttachment } from "../../../../../shared/chat";
import { checkHealth, isAbortError, loadConversation, loadHistory, observe, submit, stopConversation, uploadAttachment } from "./api";
import { pickAttachments } from "./pickAttachments";
import { mergeHistorySnapshot, prependHistoryPage } from "../../../../../shared/history";
import { applyMessageEvent } from "../../../../../shared/messages";
import { HttpStreamError } from "./transport";
function randomUUID() {
  const bytes = getRandomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export type PendingAttachment = MessageAttachment & { name: string };

export function useChat() {
  const [history, setHistory] = useState<HistoryPage>({ messages: [] }); const [draft, setDraft] = useState("");
  const messages = history.messages;
  const historyRef = useRef(history); historyRef.current = history;
  const [loadingOlder, setLoadingOlder] = useState(false); const [olderError, setOlderError] = useState("");
  const olderController = useRef<AbortController | undefined>(undefined);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false); const [reconnecting, setReconnecting] = useState(false);
  const [stopping, setStopping] = useState(false); const [submitting, setSubmitting] = useState(false); const [error, setError] = useState("");
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const mounted = useRef(true); const pending = useRef<{ id: string; message: string; createdAt: number; attachments: PendingAttachment[] } | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]); const [attaching, setAttaching] = useState(false);
  const sending = useRef(false); const submitController = useRef<AbortController | undefined>(undefined); const lastMessage = useRef("");
  const observedVersion = useRef(0);
  const stopId = useRef<string | undefined>(undefined); const modelReady = useRef(false);
  const apply = useCallback((snapshot: ConversationResponse) => {
    if (!mounted.current) return;
    const input = pending.current;
    if (input && (snapshot.messages.some(item => item.requestId === input.id) || snapshot.latest?.requestId === input.id && snapshot.latest.status !== "queued")) pending.current = null;
    const remaining = pending.current;
    setHistory(current => {
      const next = mergeHistorySnapshot(current, snapshot);
      return remaining ? { ...next, messages: [...next.messages, { id: `input-${remaining.id}`, role: "user", content: remaining.message, createdAt: remaining.createdAt, requestId: remaining.id }] } : next;
    });
    setBusy(snapshot.busy); setLoading(false); setConnected(modelReady.current);
    setError(snapshot.latest?.status === "unanswered" && snapshot.latest.error !== "aborted" ? snapshot.latest.error ?? "Reply failed." : snapshot.interruption ?? "");
  }, []);
  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener("change", state => setForeground(state === "active"));
    return () => { mounted.current = false; listener.remove(); submitController.current?.abort(); olderController.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!foreground) return;
    const controller = new AbortController(); let active = true; let checkedHealth = false;
    void (async () => {
      try { const health = await checkHealth(); if (!active) return; modelReady.current = health.modelReady; checkedHealth = true; }
      catch { if (active) setConnected(false); }
      if (!active) return;
      await observe({ signal: controller.signal, onReconnecting: value => {
          if (!active) return;
          setReconnecting(value);
          if (value) { checkedHealth = false; setConnected(false); }
          else if (!checkedHealth) {
            checkedHealth = true;
            void checkHealth().then(health => { if (active) { modelReady.current = health.modelReady; setConnected(health.modelReady); } })
              .catch(() => { if (active) { checkedHealth = false; setConnected(false); } });
          }
        },
        onEvent: event => { if (!active) return; observedVersion.current++; if (event.type === "snapshot") apply(event.conversation); else if (event.type === "message") setHistory(current => ({ ...current, messages: applyMessageEvent(current.messages, event) })); else if (event.type === "error") setError(event.message); } });
    })();
    return () => { active = false; controller.abort(); };
  }, [foreground, apply]);
  const refresh = useCallback(async () => {
    const version = observedVersion.current;
    const snapshot = await loadConversation();
    if (version === observedVersion.current) apply(snapshot);
  }, [apply]);
  const loadOlder = useCallback(async (beforePrepend?: () => void) => {
    const before = historyRef.current.nextBefore;
    if (!before || olderController.current || loading) return;
    const controller = new AbortController(); olderController.current = controller;
    setLoadingOlder(true); setOlderError("");
    try {
      const page = await loadHistory(before, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      if (historyRef.current.nextBefore === before && page.messages.length) beforePrepend?.();
      setHistory(current => prependHistoryPage(current, page, before));
    } catch (cause) {
      if (mounted.current && !isAbortError(cause) && historyRef.current.nextBefore === before) setOlderError(cause instanceof Error ? cause.message : "Couldn't load earlier messages.");
    } finally {
      olderController.current = undefined;
      if (mounted.current) setLoadingOlder(false);
    }
  }, [loading]);
  const attach = useCallback(async () => {
    if (sending.current || loading || attaching) return;
    setError("");
    let files;
    try { files = await pickAttachments(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't open the file picker."); return; }
    if (!files.length) return;
    setAttaching(true);
    try {
      const room = Math.max(0, MAX_ATTACHMENTS - attachments.length);
      if (files.length > room) setError(`Up to ${MAX_ATTACHMENTS} attachments per message.`);
      for (const file of files.slice(0, room)) {
        const stored = await uploadAttachment(file);
        setAttachments(current => current.length >= MAX_ATTACHMENTS ? current : [...current, { ...stored, name: file.name }]);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't upload the attachment."); }
    finally { if (mounted.current) setAttaching(false); }
  }, [attachments.length, loading, attaching]);
  const removeAttachment = useCallback((id: string) => { setAttachments(current => current.filter(item => item.id !== id)); }, []);
  const send = useCallback(async (text = draft, retry = false) => {
    const content = text.trim();
    const input = retry && pending.current ? pending.current
      : { id: randomUUID(), message: content, createdAt: Date.now(), attachments };
    if ((!input.message && !input.attachments.length) || sending.current || stopping || loading || attaching) return;
    pending.current = input; lastMessage.current = input.message; sending.current = true; setSubmitting(true); setDraft(""); setAttachments([]); setError("");
    setHistory(current => ({ ...current, messages: [...current.messages.filter(item => item.requestId !== input.id), { id: `input-${input.id}`, role: "user", content: input.message, createdAt: input.createdAt, requestId: input.id, ...(input.attachments.length && { attachments: input.attachments }) }] }));
    const controller = new AbortController(); submitController.current = controller;
    try { await submit(input.message, input.id, controller.signal, input.attachments.map(item => item.id)); if (mounted.current) await refresh(); }
    catch (cause) {
      if (!mounted.current || isAbortError(cause)) return;
      if (cause instanceof HttpStreamError && cause.status < 500) { pending.current = null; setDraft(input.message); setAttachments(input.attachments); setHistory(current => ({ ...current, messages: current.messages.filter(item => item.requestId !== input.id) })); }
      setError(cause instanceof Error ? cause.message : "Couldn't send message.");
    } finally { sending.current = false; if (mounted.current) setSubmitting(false); }
  }, [draft, stopping, loading, refresh, attachments, attaching]);
  const stop = useCallback(async () => {
    if (stopping) return; setStopping(true); stopId.current ??= randomUUID();
    try { await stopConversation(stopId.current); stopId.current = undefined; await refresh(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Couldn't stop reply."); }
    finally { if (mounted.current) setStopping(false); }
  }, [stopping, refresh]);
  const retry = useCallback(async () => {
    if (submitting || stopping) return;
    if (pending.current) await send(pending.current.message, true);
    else if (lastMessage.current && error && !busy) await send(lastMessage.current);
    else { try { await refresh(); } catch (cause) { setError(String(cause)); } }
  }, [send, refresh, submitting, stopping, busy, error]);
  const status = loading ? "Connecting…" : attaching ? "Uploading…" : stopping ? "Stopping…" : reconnecting ? "Reconnecting…" : busy ? "Thinking…" : connected ? "" : "Waiting to connect";
  return { ready: !loading && modelReady.current, messages, draft, setDraft, loading, busy, submitting, error, status, send, stop, retry,
    attachments, attach, removeAttachment, attaching,
    hasOlder: !!history.nextBefore, loadingOlder, olderError, loadOlder };
}
