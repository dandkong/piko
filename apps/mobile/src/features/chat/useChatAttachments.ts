import { useCallback, useRef, useState, type RefObject } from "react";
import {
  MAX_ATTACHMENTS,
  type MessageAttachment,
} from "../../../../../shared/chat";
import { uploadAttachment } from "./api";
import { pickAttachments } from "./pickAttachments";

export type PendingAttachment = MessageAttachment & { name: string };

/** Per-chat pending uploads. Stored attachment identities remain server-owned. */
export function useChatAttachments(
  loading: boolean,
  sending: RefObject<boolean>,
  mounted: RefObject<boolean>,
  onError: (error: string) => void,
) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const locked = useRef(false);
  const attach = useCallback(async () => {
    if (sending.current || loading || locked.current) return;
    locked.current = true;
    onError("");
    try {
      const files = await pickAttachments();
      if (!mounted.current || !files.length) return;
      setAttaching(true);
      const room = Math.max(0, MAX_ATTACHMENTS - attachments.length);
      if (files.length > room)
        onError(`Up to ${MAX_ATTACHMENTS} attachments per message.`);
      for (const file of files.slice(0, room)) {
        const stored = await uploadAttachment(file);
        if (!mounted.current) return;
        setAttachments((current) =>
          current.length >= MAX_ATTACHMENTS
            ? current
            : [...current, { ...stored, name: file.name }],
        );
      }
    } catch (cause) {
      if (mounted.current)
        onError(
          cause instanceof Error ? cause.message : "无法附加文件。",
        );
    } finally {
      locked.current = false;
      if (mounted.current) setAttaching(false);
    }
  }, [attachments.length, loading, sending, mounted, onError]);
  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((item) => item.id !== id));
  }, []);
  return { attachments, setAttachments, attaching, attach, removeAttachment };
}
