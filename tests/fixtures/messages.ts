import type { MessageEvent } from "../../shared/messages";

export function messageEvent(content: string, id = "live-test", final = false, previousId?: string): MessageEvent {
  return { type: "message", message: { id, role: "assistant", content, createdAt: 2 }, final,
    ...(previousId && { previousId }) };
}
