import { describe, expect, test } from "bun:test";
import { consumeSse } from "../src/shared/chat";

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
});
