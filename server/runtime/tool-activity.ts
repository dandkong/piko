import { SUMMARY_TEXT_LIMIT, singleLine } from "./text";

function pick(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

/** Emoji per built-in tool; unknown tools get a generic wrench. */
export function toolIcon(name: string): string {
  if (name.startsWith("subagent_")) return "🤖";
  if (name.startsWith("task_")) return "🗓️";
  switch (name) {
    case "read": return "📖";
    case "write": return "📄";
    case "edit": return "📝";
    case "bash": return "💻";
    case "web_search": return "🔍";
    case "web_extract": return "🌐";
    default: return "🛠️";
  }
}

/** What the call is about, derived from arguments; never includes file contents. */
export function summarizeToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  // Every tool shares one bound: branches may build longer text from several fields.
  return singleLine(summarize(toolName, args as Record<string, unknown>), SUMMARY_TEXT_LIMIT) ?? "";
}

function summarize(toolName: string, record: Record<string, unknown>): string {
  if (toolName === "read" || toolName === "write") return pick(record, "path") ?? "";
  if (toolName === "bash") return pick(record, "command") ?? "";
  if (toolName === "edit") {
    const path = pick(record, "path");
    const edits = Array.isArray(record.edits) ? record.edits.length : undefined;
    return path ? `${path}${edits ? ` (${edits} edit${edits === 1 ? "" : "s"})` : ""}` : "";
  }
  if (toolName === "web_search") return pick(record, "query") ?? "";
  if (toolName === "web_extract") return pick(record, "url") ?? "";
  if (toolName.startsWith("subagent_")) {
    const id = pick(record, "id");
    const task = pick(record, "task") ?? pick(record, "message");
    return [id && `#${id}`, task].filter(Boolean).join(" ");
  }
  if (toolName.startsWith("task_")) {
    const id = pick(record, "id");
    const detail = pick(record, "title") ?? pick(record, "prompt");
    return [id && `#${id.slice(0, 8)}`, detail].filter(Boolean).join(" ");
  }
  const entries = Object.entries(record).slice(0, 2).filter(([, value]) => typeof value === "string");
  return entries.map(([key, value]) => `${key}=${String(value)}`).join(", ");
}
