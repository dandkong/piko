import { MAX_MESSAGE_LENGTH } from "../../shared/chat";

export function normalizeMessage(message: string): string {
  if (!message.trim() || message.length > MAX_MESSAGE_LENGTH) {
    throw new Error("Message must contain 1–12,000 characters.");
  }
  return message.trim();
}
