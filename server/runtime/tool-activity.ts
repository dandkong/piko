/** One Telegram/UI line per call: whitespace collapsed, bounded length. */
const LIMIT = 100;

function singleLine(value: string | undefined, limit = LIMIT): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? (text.length > limit ? `${text.slice(0, limit - 3)}...` : text) : undefined;
}

function pick(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

/** What the call is about, derived from arguments; never includes file contents. */
export function summarizeToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const record = args as Record<string, unknown>;
  if (toolName === "read" || toolName === "write") return singleLine(pick(record, "path")) ?? "";
  if (toolName === "bash") return singleLine(pick(record, "command")) ?? "";
  if (toolName === "edit") {
    const path = singleLine(pick(record, "path"));
    const edits = Array.isArray(record.edits) ? record.edits.length : undefined;
    return path ? `${path}${edits ? ` (${edits} edit${edits === 1 ? "" : "s"})` : ""}` : "";
  }
  if (toolName === "web_search") return singleLine(pick(record, "query")) ?? "";
  if (toolName === "web_extract") return singleLine(pick(record, "url")) ?? "";
  const entries = Object.entries(record).slice(0, 2).filter(([, value]) => typeof value === "string");
  return singleLine(entries.map(([key, value]) => `${key}=${String(value)}`).join(", ")) ?? "";
}
