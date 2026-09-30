import { describe, expect, test } from "bun:test";
import { consumeSse } from "../shared/sse";

describe("consumeSse", () => {
  test("keeps an incomplete event until the next chunk arrives", () => {
    const first = consumeSse('data: {"type":"delta",');
    expect(first.events).toEqual([]);

    const second = consumeSse(`${first.remainder}"text":"hello"}\n\n`);
    expect(second.events).toEqual([{ type: "delta", text: "hello" }]);
    expect(second.remainder).toBe("");
  });

  test("parses multiple CRLF-delimited events and flushes a final event", () => {
    const parsed = consumeSse(
      'data: {"type":"delta","text":"hi"}\r\n\r\ndata: {"type":"done"}',
      true,
    );
    expect(parsed.events).toEqual([{ type: "delta", text: "hi" }, { type: "done" }]);
    expect(parsed.remainder).toBe("");
  });

  test("preserves replay metadata and ignores heartbeat comments", () => {
    expect(consumeSse(': heartbeat\n\ndata: {"type":"cancelled","runId":"run","sequence":3}\n\n').events)
      .toEqual([{ type: "cancelled", runId: "run", sequence: 3 }]);
  });

  test("retains CRLF delimiters split across chunks", () => {
    const first = consumeSse('data: {"type":"delta","text":"你好"}\r\n\r');
    expect(first.events).toEqual([]);
    expect(consumeSse(first.remainder + '\n').events).toEqual([{ type: "delta", text: "你好" }]);
  });
});
