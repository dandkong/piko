import { useCallback, useRef, useState, type RefObject, type SetStateAction } from "react";
import { MAX_ATTACHMENTS, type MessageAttachment } from "../../../../../shared/chat";
import { errorMessage } from "../../api/errors";
import { uploadAttachment, type PickedFile } from "./api";
import { pickAttachments } from "./pickAttachments";
import { useTranslation } from "../../i18n";
import { createUuidV4 } from "../../utils/uuid";

export type PendingAttachment = MessageAttachment & { name: string };

/** Completed uploads stay attached; pending selections and pastes share one retryable queue. */
export function useChatAttachments(loading: boolean, sending: RefObject<boolean>, mounted: RefObject<boolean>, onError: (error: string) => void) {
  const { t } = useTranslation();
  const [attachments, setAttachmentState] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const setAttachments = useCallback((update: SetStateAction<PendingAttachment[]>) => {
    const next = typeof update === "function" ? update(attachmentsRef.current) : update;
    attachmentsRef.current = next;
    setAttachmentState(next);
  }, []);
  const [attaching, setAttaching] = useState(false);
  const locked = useRef(false);
  const picking = useRef(false);
  // The first item remains in the queue until upload succeeds, including on failure.
  const remaining = useRef<PickedFile[]>([]);
  const drain = useCallback(async () => {
    if (sending.current || loading || locked.current || !remaining.current.length) return;
    locked.current = true;
    setAttaching(true);
    try {
      while (remaining.current.length) {
        const file = remaining.current[0]!;
        const stored = await uploadAttachment(file);
        if (!mounted.current) return;
        remaining.current.shift();
        setAttachments(current => [...current, { ...stored, name: file.name }]);
      }
    } catch (cause) {
      if (mounted.current) onError(errorMessage(cause, t("chat.uploadFailed"), t));
    } finally {
      locked.current = false;
      if (mounted.current) setAttaching(false);
    }
  }, [loading, sending, mounted, onError, setAttachments, t]);
  const enqueue = useCallback((files: PickedFile[]) => {
    if (!mounted.current || !files.length) return;
    if (sending.current || loading) {
      onError(t("chat.attachmentBusy"));
      return;
    }
    onError("");
    const room = Math.max(0, MAX_ATTACHMENTS - attachmentsRef.current.length - remaining.current.length);
    if (files.length > room) onError(t("chat.attachmentLimit", { count: MAX_ATTACHMENTS }));
    remaining.current.push(...files.slice(0, room));
    void drain();
  }, [drain, loading, mounted, onError, sending, t]);
  const attach = useCallback(async () => {
    if (sending.current || loading || picking.current || locked.current) return;
    picking.current = true;
    try {
      enqueue(await pickAttachments(t("chat.nativeAttachment")));
    } catch (cause) {
      if (mounted.current) onError(errorMessage(cause, t("chat.uploadFailed"), t));
    } finally {
      picking.current = false;
    }
  }, [enqueue, loading, mounted, onError, sending, t]);
  const pasteFiles = useCallback((files: File[]) => {
    enqueue(files.map(file => ({
      name: file.name || "image",
      // Stored names must be unique: the server overwrites files with identical names.
      uploadName: `paste-${createUuidV4()}-${file.name.split(/[\\/]/).pop() || "image"}`,
      mime: file.type,
      bytes: file,
    })));
  }, [enqueue]);
  const retryUpload = useCallback(async () => {
    if (remaining.current.length) { onError(""); await drain(); }
    else await attach();
  }, [attach, drain, onError]);
  const removeAttachment = useCallback((id: string) => setAttachments(current => current.filter(item => item.id !== id)), [setAttachments]);
  return { attachments, setAttachments, attaching, attach, pasteFiles, retryUpload, removeAttachment };
}
