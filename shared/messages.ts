import type { Message, StreamEvent } from "./chat";

export type MessageEvent = Extract<StreamEvent, { type: "message" }>;

/** A committed entry replaces its live identity in place, preserving conversation order. */
export function applyMessageEvent(messages: readonly Message[], event: MessageEvent): Message[] {
  const ids = new Set([event.message.id, event.previousId]);
  const index = messages.findIndex(message => ids.has(message.id));
  const result = messages.filter(message => !ids.has(message.id));
  if (event.message.content.trim() || event.message.attachments?.length) result.splice(index < 0 ? result.length : Math.min(index, result.length), 0, event.message);
  return result;
}
