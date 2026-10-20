export type ChatBatchMessage = { role: "user" | "assistant"; date: string; content: string };
export const CHAT_BATCH_MAX_INPUT_CHARS = 48_000;

const SECRET_PATTERNS = [
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[A-Z0-9]{16}|bot\d{6,}:[A-Za-z0-9_-]{20,})\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}={0,2}/gi,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|password|passwd|secret|database_url|connection_string)\s*[:=]\s*["']?[^\s"'`,;]+/gi,
];

/** Reduce accidental credential copying into a background child conversation; not a general secret scanner. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((value, pattern) => value.replace(pattern, "[redacted credential]"), text);
}

export function localDate(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(timestamp);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
