import { MAX_MESSAGE_LENGTH } from "../../shared/chat";

export function normalizeMessage(message: string, allowEmpty = false): string {
  const text = message.trim();
  if ((!text && !allowEmpty) || text.length > MAX_MESSAGE_LENGTH) {
    throw new Error("Message must contain 1–12,000 characters.");
  }
  return text;
}

/** One channel-agnostic representation for the model: attachment paths first, then the user's text. */
export function attachmentPrompt(text: string, paths: readonly string[]): string {
  if (!paths.length) return text;
  return ["<attached>", ...paths, "</attached>", ...(text ? [text] : [])].join("\n");
}
