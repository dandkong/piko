import type { ConversationResponse, Message } from "../../../shared/chat";
import type { CompactionEvent, ModelSelection, RuntimeDescription } from "../../../shared/runtime";

// One order for both setMyCommands and /help. Frequent controls first, onboarding last.
export const TELEGRAM_COMMANDS = [
  { command: "status", description: "Show current session status" },
  { command: "compact", description: "Compact context" },
  { command: "models", description: "Choose model" },
  { command: "thinking", description: "Set thinking level" },
  { command: "stop", description: "Stop the current reply" },
  { command: "recent", description: "Show recent messages" },
  { command: "subagent", description: "Browse background work" },
  { command: "skills", description: "Browse skills" },
  { command: "help", description: "Show available commands" },
  { command: "start", description: "Welcome and quick start" },
];
export const WELCOME = "Welcome. Send a request directly, or use /help to see available commands.\nYour main conversation is shared with the Piko app.";
export function formatHelp(): string {
  return ["Available commands:", ...TELEGRAM_COMMANDS.map(item => `/${item.command} - ${item.description}`), "",
    "You can also send a request directly.",
    "Model and thinking changes apply to the shared main conversation, not side chats or the background model profile.",
    "Changes and /compact require Piko to be idle. /stop cancels the current reply or maintenance, not independent background work.",
    "Use /recent for message summaries; open the Piko app for full history."].join("\n");
}
export function sameModel(a?: ModelSelection, b?: ModelSelection): boolean {
  return !!a && !!b && a.provider === b.provider && a.model === b.model;
}
export function currentModel(description: RuntimeDescription): string {
  const selected = description.selection;
  if (!selected) return "No model selected";
  const model = description.models.find(item => item.provider === selected.provider && item.id === selected.model);
  return `${selected.provider}/${model?.name ?? selected.model} • ${selected.thinking ?? "off"}`;
}
export function selectionText(description: RuntimeDescription): string { return `Current: ${currentModel(description)}`; }
export function busyMessage(action: "model" | "thinking" | "compact"): string {
  const operation = action === "compact" ? "compact context" : action === "model" ? "change model" : "change thinking level";
  return `Cannot ${operation} while a reply or maintenance is in progress. Use /stop or wait for completion.`;
}
export function formatStatus(snapshot: ConversationResponse, description: RuntimeDescription): string {
  const usage = snapshot.usage;
  const used = usage && usage.input + usage.cacheRead + usage.cacheWrite;
  const number = (value: number) => Math.round(value).toLocaleString("en-US");
  const context = used === undefined ? "unknown" : number(used) + (usage?.contextWindow
    ? ` / ${number(usage.contextWindow)} (${((usage.ratio ?? used / usage.contextWindow) * 100).toFixed(1)}%)` : "");
  return ["Status", `Model: ${currentModel(description)}`, `Context: ${context}`,
    `State: ${snapshot.compactions?.length ? "Compacting" : snapshot.busy ? "Working" : "Ready"}`, `Skills: ${description.skills.length}`,
    ...(snapshot.interruption ? [snapshot.interruption] : []),
    ...(snapshot.latest?.status === "unanswered" ? [`Last input: ${snapshot.latest.error === "aborted" ? "Stopped" : "Failed"}`] : []),
  ].join("\n");
}
export function formatCompaction(event: CompactionEvent): string {
  if (event.phase === "start") {
    const reason = event.reason === "manual" ? "manual" : event.reason === "threshold" ? "threshold reached" : "context overflow";
    return `🔄 Compacting context (${reason})...`;
  }
  const result = event.result;
  if (result.status === "compacted") return "✅ Context compacted.";
  if (result.status === "cancelled") return "⚠️ Compaction aborted.";
  return "❌ Compaction failed. Try /compact again.";
}
export function formatRecent(messages: readonly Message[]): string {
  const recent = messages.filter(item => !item.id.startsWith("live-") && !item.id.startsWith("input-")).slice(-10);
  if (!recent.length) return "No recent user or assistant messages.";
  return recent.map(item => {
    const text = item.content.replace(/\s+/g, " ").trim() || (item.attachments?.length ? `[${item.attachments.length} attachment(s)]` : "(empty message)");
    const chars = Array.from(text);
    const summary = chars.length > 100 ? chars.slice(0, 97).join("") + "..." : text;
    return `${item.role === "user" ? "👤" : "🧑‍💻"} ${summary}`;
  }).join("\n");
}
