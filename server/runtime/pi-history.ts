import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isSessionId, type Message } from "../../shared/chat";
import type { SessionHistory } from "./types";

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is { type: "text"; text: string } =>
    part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
}

/** Full selected branch, not Pi's compacted LLM context; never persist this projection. */
export function projectPiHistory(entries: SessionEntry[]): SessionHistory {
  const messages: Message[] = [];
  const runs: SessionHistory["runs"] = new Map();
  let runId: string | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === "piko-run") {
      const id = (entry.data as { runId?: unknown } | undefined)?.runId;
      runId = isSessionId(id) ? id : undefined;
      if (runId) runs.set(runId, { message: "", text: "" });
      continue;
    }
    let role: Message["role"];
    let content: string;
    let belongsToRun = false;
    if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
      role = entry.message.role;
      content = messageText(entry.message.content);
      belongsToRun = true;
      const run = runId && runs.get(runId);
      if (run) {
        if (role === "user" && !run.message) run.message = content;
        if (role === "assistant") run.text += content;
      }
    } else if (entry.type === "custom_message" && entry.display) {
      // Background results can use Pi custom messages; hidden guidance stays hidden.
      role = "assistant";
      content = messageText(entry.content);
    } else continue;
    if (!content.trim()) continue;
    messages.push({ id: "pi-" + entry.id, role, content, createdAt: Date.parse(entry.timestamp),
      ...(belongsToRun && runId && { runId }) });
  }
  return { messages, runs };
}
