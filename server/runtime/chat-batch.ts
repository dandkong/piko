import { ROOT_CONVERSATION_ID, type Cursor, type EntryId, type EntryRecord, type Tx } from "@earendil-works/pi-durable";
import { CHAT_BATCH_MAX_INPUT_CHARS, localDate, redactSecrets, type ChatBatchMessage } from "../domain/chat-batch";
import { internalInput } from "./input-origin";
import { messageText } from "./pi-history";

export type CollectedBatch = { messages: ChatBatchMessage[]; userMessageCount: number; throughEntryId: number };

/** Newest entry ID of the root conversation; background work uses it as a high-water cursor. */
export async function rootHighWater(tx: Tx): Promise<number> {
  const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "descending" }, 1);
  return page.items[0]?.id ?? 0;
}

/** Collect only external, user-visible root chat text. Internal reports and tool results are never input. */
export async function collectMainChatBatch(tx: Tx, input: {
  from: number; through: number; timezone: string; bindings: ReadonlyMap<number, string>; now: number;
}): Promise<CollectedBatch> {
  const { from, through, timezone, bindings, now } = input;
  const entries: EntryRecord[] = []; let cursor: Cursor | undefined;
  if (through > from) do {
    const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, minEntryId: (from + 1) as EntryId,
      maxEntryId: through as EntryId, order: "ascending" }, 500, cursor);
    entries.push(...page.items); cursor = page.next;
  } while (cursor);

  const internalUsers = new Set<number>(); const internalAnswers = new Set<number>();
  for (const entry of entries) {
    if (entry.kind !== "pi.user") continue;
    const requestId = bindings.get(entry.id);
    if (!await internalInput(tx, requestId)) continue;
    internalUsers.add(entry.id);
    const submission = requestId ? await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId) : undefined;
    if (submission?.type === "input" && submission.status === "done") internalAnswers.add(submission.answer);
  }

  const messages: ChatBatchMessage[] = []; let userMessageCount = 0; let chars = 0; let processed = from;
  for (const entry of entries) {
    if ((entry.kind !== "pi.user" && entry.kind !== "pi.assistant") || internalUsers.has(entry.id) || internalAnswers.has(entry.id)) {
      processed = entry.id; continue;
    }
    const parts = (entry.model ?? []).filter(message => message.role === "user" || message.role === "assistant")
      .map(message => ({ timestamp: typeof message.timestamp === "number" ? message.timestamp : now,
        content: redactSecrets(messageText(message.content)).trim() }))
      .filter(message => message.content.length > 0);
    if (!parts.length) { processed = entry.id; continue; }
    const role = entry.kind === "pi.user" ? "user" : "assistant";
    const cost = parts.reduce((sum, part) => sum + part.content.length, 0);
    if (messages.length && chars + cost > CHAT_BATCH_MAX_INPUT_CHARS) break;
    if (role === "user") userMessageCount++;
    let remaining = CHAT_BATCH_MAX_INPUT_CHARS - chars;
    for (const part of parts) {
      if (remaining <= 0) break;
      const content = part.content.length > remaining ? `${part.content.slice(0, remaining)}\n[This message was abbreviated to fit the batch.]` : part.content;
      messages.push({ role, date: localDate(part.timestamp, timezone), content });
      remaining -= Math.min(part.content.length, remaining);
    }
    chars += Math.min(cost, CHAT_BATCH_MAX_INPUT_CHARS - chars);
    processed = entry.id;
    if (chars >= CHAT_BATCH_MAX_INPUT_CHARS) break;
  }
  return { messages, userMessageCount, throughEntryId: Math.max(from, processed) };
}
