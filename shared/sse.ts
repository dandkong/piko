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
    if (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "delta" &&
      "text" in value &&
      typeof value.text === "string"
    ) {
      events.push({ type: "delta", text: value.text });
    } else if (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "done"
    ) {
      events.push({ type: "done" });
    } else if (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "error" &&
      "message" in value &&
      typeof value.message === "string"
    ) {
      events.push({ type: "error", message: value.message });
    }
  }

  return { events, remainder };
}
