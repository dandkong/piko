import { useCallback, useRef, useState, type RefObject } from "react";
import { MAX_ATTACHMENTS, type MessageAttachment } from "../../../../../shared/chat";
import { errorMessage } from "../../api/errors";
import { uploadAttachment, type PickedFile } from "./api";
import { pickAttachments } from "./pickAttachments";
import { useTranslation } from "../../i18n";

export type PendingAttachment = MessageAttachment & { name: string };

/** Completed uploads stay attached; retries only upload the remaining selected files. */
export function useChatAttachments(loading: boolean, sending: RefObject<boolean>, mounted: RefObject<boolean>, onError: (error: string) => void) {
  const { t } = useTranslation();
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const locked = useRef(false);
  const remaining = useRef<PickedFile[]>([]);
  const run = useCallback(async (retry: boolean) => {
    if (sending.current || loading || locked.current) return;
    locked.current = true;
    onError("");
    try {
      if (!retry || !remaining.current.length) {
        const files = await pickAttachments(t("chat.nativeAttachment"));
        if (!mounted.current || !files.length) return;
        const room = Math.max(0, MAX_ATTACHMENTS - attachments.length);
        if (files.length > room) onError(t("chat.attachmentLimit", { count: MAX_ATTACHMENTS }));
        remaining.current = files.slice(0, room);
      }
      setAttaching(true);
      while (remaining.current.length) {
        const file = remaining.current[0]!;
        const stored = await uploadAttachment(file);
        if (!mounted.current) return;
        remaining.current.shift();
        setAttachments(current => current.length >= MAX_ATTACHMENTS ? current : [...current, { ...stored, name: file.name }]);
      }
    } catch (cause) {
      if (mounted.current) onError(errorMessage(cause, t("chat.uploadFailed"), t));
    } finally {
      locked.current = false;
      if (mounted.current) setAttaching(false);
    }
  }, [attachments.length, loading, sending, mounted, onError, t]);
  const attach = useCallback(() => run(false), [run]);
  const retryUpload = useCallback(() => run(true), [run]);
  const removeAttachment = useCallback((id: string) => setAttachments(current => current.filter(item => item.id !== id)), []);
  return { attachments, setAttachments, attaching, attach, retryUpload, removeAttachment };
}
