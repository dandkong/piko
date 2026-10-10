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

export async function readPiHistory(session: Session): Promise<SessionHistory> {
  const entries = await readPiEntries(session);
  return projectPiHistory(entries, await readPiInputs(session, entries));
}

/** Bind placed user entries to request identities using native submission records, without storing their bodies. */
export async function readPiInputs(session: Session, entries: readonly EntryRecord[]): Promise<Map<number, string>> {
  return session.commit(async tx => {
    const bindings = new Map<number, string>();
    for (const entry of entries) {
      if (entry.kind !== "piko.input") continue;
      const id = data(entry).runId;
      if (!isSessionId(id)) continue;
      const submission = await tx.submissionByRequest(entry.conversationId, id);
      if (submission?.type === "input" && submission.entry !== undefined) bindings.set(submission.entry, id);
    }
    return bindings;
  }, context);
}

export function projectPiHistory(entries: readonly EntryRecord[], inputs = new Map<number, string>()): SessionHistory {
  const messages: Message[] = [];
  const runs: SessionHistory["runs"] = new Map();
  let runId: string | undefined;
  for (const entry of entries) {
    if (entry.kind !== "piko.input") continue;
    const value = data(entry);
    if (isSessionId(value.runId) && isSessionId(value.executionId)) {
      runs.set(value.runId, { message: "", text: "", executionId: value.executionId });
    }
  }
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
        const messageRunId = message.role === "user" ? inputs.get(entry.id) ?? runId : runId;
        const run = messageRunId && runs.get(messageRunId);
        if (run) {
          if (message.role === "user" && !run.message) run.message = content;
          if (message.role === "assistant") run.text += content;
        }
        if (content.trim()) messages.push({ id: "pi-" + entry.id, role: message.role, content,
          createdAt: message.timestamp, ...(messageRunId && { runId: messageRunId }) });
      }
    } else if (entry.kind === "piko.result" && data(entry).display === true) {
      const content = (entry.model ?? []).map(message => "content" in message ? messageText(message.content) : "").join("");
      if (content.trim()) messages.push({ id: "pi-" + entry.id, role: "assistant", content, createdAt: Number(data(entry).createdAt ?? 0) });
    }
  }
  for (const [id, run] of runs) {
    if (run.executionId && run.executionId !== id) run.text = runs.get(run.executionId)?.text ?? "";
  }
  return { messages, runs };
}

function data(entry: EntryRecord): Record<string, unknown> {
  return entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data : {};
}
