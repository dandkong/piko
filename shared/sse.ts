import type { StreamEvent } from "./chat";
export function encodeSse(event: StreamEvent): string { return `data: ${JSON.stringify(event)}\n\n`; }
export function consumeSse(buffer: string, flush = false): { events: StreamEvent[]; remainder: string } {
  const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const remainder = flush ? "" : (blocks.pop() ?? ""); const events: StreamEvent[] = [];
  for (const block of blocks) {
    const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) continue;
    const value = JSON.parse(data);
    if (!value || typeof value !== "object") continue;
    if (value.type === "snapshot" && value.conversation && Array.isArray(value.conversation.messages) && typeof value.conversation.busy === "boolean") events.push(value);
    else if (value.type === "message" && value.message && typeof value.message.id === "string" && typeof value.message.content === "string" && typeof value.final === "boolean") events.push(value);
    else if (value.type === "refresh" || value.type === "error" && typeof value.message === "string") events.push(value);
  }
  return { events, remainder };
}
