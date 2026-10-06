import type { Cursor, EntryRecord, Session, ConversationId } from "@earendil-works/pi-durable";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { isSessionId, type Message } from "../../shared/chat";
import type { SessionHistory } from "./types";

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is { type: "text"; text: string } =>
    part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
}

/** Full history, including entries before reset/compaction and context edits. */
export async function readPiEntries(session: Session, conversationId: ConversationId = ROOT_CONVERSATION_ID): Promise<EntryRecord[]> {
  return session.commit(async tx => {
    const entries: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanEntries({ conversationId }, 500, cursor);
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return entries.sort((a, b) => a.id - b.id);
  }, context);
}

export function projectPiHistory(entries: readonly EntryRecord[]): SessionHistory {
  const messages: Message[] = [];
  const runs: SessionHistory["runs"] = new Map();
  let runId: string | undefined;
  for (const entry of entries) {
    if (entry.kind === "piko.run") {
      const id = data(entry).runId;
      runId = isSessionId(id) ? id : undefined;
      if (runId && !runs.has(runId)) runs.set(runId, { message: "", text: "" });
      continue;
    }
    if (entry.kind === "pi.user" || entry.kind === "pi.assistant") {
      for (const message of entry.model ?? []) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        const content = messageText(message.content);
        const run = runId && runs.get(runId);
        if (run) {
          if (message.role === "user" && !run.message) run.message = content;
          if (message.role === "assistant") run.text += content;
        }
        if (content.trim()) messages.push({ id: "pi-" + entry.id, role: message.role, content,
          createdAt: message.timestamp, ...(runId && { runId }) });
      }
    } else if (entry.kind === "piko.result" && data(entry).display === true) {
      const content = (entry.model ?? []).map(message => "content" in message ? messageText(message.content) : "").join("");
      if (content.trim()) messages.push({ id: "pi-" + entry.id, role: "assistant", content, createdAt: Number(data(entry).createdAt ?? 0) });
    }
  }
  return { messages, runs };
}

function data(entry: EntryRecord): Record<string, unknown> {
  return entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data : {};
}
