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
      (value.type === "delta" || value.type === "replace") &&
      "text" in value &&
      typeof value.text === "string"
    ) {
      events.push({ type: value.type, text: value.text, ...metadata });
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
