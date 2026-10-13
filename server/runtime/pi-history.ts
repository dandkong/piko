import type { Cursor, EntryRecord, Session, Storage, ConversationId, Tx } from "@earendil-works/pi-durable";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { internalInput } from "./input-origin";
import { CHAT_PAGE_SIZE, type HistoryPage, type Message } from "../../shared/chat";

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is { type: "text"; text: string } =>
    part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
}

/** Full history, including entries before reset/compaction and context edits. */
export async function readPiEntries(session: Session, conversationId: ConversationId = ROOT_CONVERSATION_ID): Promise<EntryRecord[]> {
  return session.commit(tx => entriesFromTransaction(tx, conversationId), context);
}

export async function entriesFromTransaction(tx: Tx, conversationId = ROOT_CONVERSATION_ID): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId }, 500, cursor);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return entries.sort((a, b) => a.id - b.id);
}

export async function readPiInputs(session: Session, storage: Storage): Promise<Map<number, string>> {
  return session.commit(() => inputsFromStorage(storage), context);
}

/** Call on the native commit line so submission bindings and entries share a consistent read. */
export async function inputsFromStorage(storage: Storage): Promise<Map<number, string>> {
  const bindings = new Map<number, string>(); let cursor: Cursor | undefined;
  do {
    const page = await storage.scanSubmissions({ conversationId: ROOT_CONVERSATION_ID }, 500, cursor, context);
    for (const record of page.items) if (record.type === "input" && record.requestId && record.entry !== undefined) bindings.set(record.entry, record.requestId);
    cursor = page.next;
  } while (cursor);
  return bindings;
}
export async function readPiHistory(session: Session, storage: Storage) {
  return session.commit(async tx => {
    const entries = await entriesFromTransaction(tx); const inputs = await inputsFromStorage(storage); const hidden = new Set<number>();
    for (const [entry, requestId] of inputs) if (await internalInput(tx, requestId)) hidden.add(entry);
    return projectPiHistory(entries, inputs, hidden);
  }, context);
}

/** Read only enough raw entries to fill a visible page plus one lookahead message.
 * Bounds use immutable entry IDs, so new writes cannot shift an older-page cursor.
 * Bindings are an in-memory projection of native submissions, never a second store.
 */
export async function historyPageFromTransaction(tx: Tx, inputs: ReadonlyMap<number, string>, before?: string, limit = CHAT_PAGE_SIZE) {
  const entries: EntryRecord[] = [];
  const messages: Message[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "descending",
      ...(before && { maxEntryId: (Number(before) - 1) as EntryRecord["id"] }) }, 100, cursor);
    for (const entry of page.items) {
      entries.push(entry);
      if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant" && entry.kind !== "piko.result") continue;
      const requestId = inputs.get(entry.id);
      if (requestId && await internalInput(tx, requestId)) continue;
      const projected = projectPiHistory([entry], requestId ? new Map([[entry.id, requestId]]) : undefined).messages;
      messages.push(...projected.reverse());
      if (messages.length > limit) break;
    }
    cursor = page.next;
  } while (cursor && messages.length <= limit);
  const selected = messages.slice(0, limit).reverse();
  const result: HistoryPage = { messages: selected,
    ...(messages.length > limit && { nextBefore: selected[0]!.id.slice(3) }) };
  return { ...result, entries };
}

export function projectPiHistory(entries: readonly EntryRecord[], inputs = new Map<number, string>(), hidden = new Set<number>()) {
  const messages: Message[] = [];
  for (const entry of entries) {
    if (hidden.has(entry.id)) continue;
    if (entry.kind === "pi.user" || entry.kind === "pi.assistant") {
      for (const message of entry.model ?? []) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        const content = messageText(message.content);
        const requestId = message.role === "user" ? inputs.get(entry.id) : undefined;
        if (content.trim()) messages.push({ id: "pi-" + entry.id, role: message.role, content,
          createdAt: message.timestamp, ...(requestId && { requestId }) });
      }
    } else if (entry.kind === "piko.result" && data(entry).display === true) {
      const content = (entry.model ?? []).map(message => "content" in message ? messageText(message.content) : "").join("");
      if (content.trim()) messages.push({ id: "pi-" + entry.id, role: "assistant", content, createdAt: Number(data(entry).createdAt ?? 0) });
    }
  }
  return { messages };
}

function data(entry: EntryRecord): Record<string, unknown> {
  return entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data : {};
}
