import { isHistoryCursor, type ConversationResponse, type HistoryPage } from "./chat";

function entryId(id: string): number | undefined {
  return isHistoryCursor(id) ? Number(id) : undefined;
}

/** Replace the recent authoritative window, including transient/withdrawn inputs.
 * Preserve older pages only when they overlap: a reconnect can otherwise hide a gap.
 */
export function mergeHistorySnapshot(current: HistoryPage, snapshot: ConversationResponse): HistoryPage {
  if (!snapshot.history) return { messages: snapshot.messages };
  const persisted = snapshot.messages.filter(message => entryId(message.id) !== undefined);
  const ids = new Set(persisted.map(message => message.id));
  const overlaps = current.messages.some(message => ids.has(message.id));
  const first = persisted[0] && entryId(persisted[0].id)!;
  const older = overlaps && first !== undefined ? current.messages.filter(message => {
    const id = entryId(message.id);
    return id !== undefined && id < first;
  }) : [];
  return { messages: [...older, ...snapshot.messages],
    nextBefore: older.length ? current.nextBefore : snapshot.history.nextBefore };
}

/** A stale older-page request must not join a newly reset/discontinuous window. */
export function prependHistoryPage(current: HistoryPage, page: HistoryPage, before: string): HistoryPage {
  if (current.nextBefore !== before) return current;
  const ids = new Set(current.messages.map(message => message.id));
  return { messages: [...page.messages.filter(message => !ids.has(message.id)), ...current.messages], nextBefore: page.nextBefore };
}
