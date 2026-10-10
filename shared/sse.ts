import type { StreamEvent } from "./chat";

export function encodeSse(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Parse complete SSE data blocks while retaining any partial block for the next chunk. */
export function consumeSse(
  buffer: string,
  flush = false,
): { events: StreamEvent[]; remainder: string } {
  const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const remainder = flush ? "" : (blocks.pop() ?? "");
  const events: StreamEvent[] = [];

  for (const block of blocks) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;

    const value: unknown = JSON.parse(data);
    const metadata: { runId?: string; sequence?: number } = {};
    if (typeof value === "object" && value !== null) {
      if ("runId" in value && typeof value.runId === "string") metadata.runId = value.runId;
      if ("sequence" in value && typeof value.sequence === "number" && Number.isSafeInteger(value.sequence) && value.sequence > 0) metadata.sequence = value.sequence;
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "message" && "message" in value && typeof value.message === "object" && value.message !== null &&
      "id" in value.message && typeof value.message.id === "string" &&
      "role" in value.message && value.message.role === "assistant" &&
      "content" in value.message && typeof value.message.content === "string" &&
      "createdAt" in value.message && typeof value.message.createdAt === "number" &&
      "final" in value && typeof value.final === "boolean"
    ) {
      events.push({ type: "message", message: { id: value.message.id, role: "assistant", content: value.message.content,
        createdAt: value.message.createdAt }, final: value.final,
        ...("previousId" in value && typeof value.previousId === "string" && { previousId: value.previousId }), ...metadata });
    } else if (typeof value === "object" && value !== null && "type" in value && value.type === "refresh") {
      events.push({ type: "refresh", ...metadata });
    } else if (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "done"
    ) {
      events.push({ type: "done", ...metadata });
    } else if (
      typeof value === "object" && value !== null && "type" in value && value.type === "cancelled"
    ) {
      events.push({ type: "cancelled", ...metadata });
    } else if (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "error" &&
      "message" in value &&
      typeof value.message === "string"
    ) {
      events.push({ type: "error", message: value.message, ...metadata });
    }
  }

  return { events, remainder };
}
