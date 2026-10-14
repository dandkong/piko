import { describe, expect, test } from "bun:test";
import { consumeSse, encodeSse } from "../shared/sse";
import { applyMessageEvent } from "../shared/messages";
import { messageEvent } from "./fixtures/messages";

describe("message streams", () => {
  test("keeps an incomplete event until the next chunk arrives", () => {
    const encoded = encodeSse(messageEvent("hello"));
    const first = consumeSse(encoded.slice(0, 24));
    expect(first.events).toEqual([]);
    expect(consumeSse(first.remainder + encoded.slice(24)).events).toEqual([messageEvent("hello")]);
  });
  test("parses CRLF, final blocks and replay metadata", () => {
    expect(consumeSse(encodeSse(messageEvent("hi")).replaceAll("\n", "\r\n") + 'data: {"type":"refresh"}', true).events)
      .toEqual([messageEvent("hi"), { type: "refresh" }]);
    expect(consumeSse(': heartbeat\n\ndata: {"type":"refresh"}\n\n').events)
      .toEqual([{ type: "refresh" }]);
    const first = consumeSse(encodeSse(messageEvent("你好")).replaceAll("\n", "\r\n").slice(0, -1));
    expect(consumeSse(first.remainder + "\n").events).toEqual([messageEvent("你好")]);
  });
  test("a steer preserves the preceding reply and final entries replace live identities in place", () => {
    let messages = [messageEvent("Before.").message, { id: "user-2", role: "user" as const, content: "correction", createdAt: 3 }];
    messages = applyMessageEvent(messages, messageEvent("Before.", "pi-1", true, "live-test"));
    messages = applyMessageEvent(messages, messageEvent("After.", "live-after"));
    messages = applyMessageEvent(messages, messageEvent("Corrected.", "live-after"));
    messages = applyMessageEvent(messages, messageEvent("Corrected.", "pi-2", true, "live-after"));
    expect(messages.map(message => message.content)).toEqual(["Before.", "correction", "Corrected."]);
    expect(messages.map(message => message.id)).toEqual(["pi-1", "user-2", "pi-2"]);
    expect(applyMessageEvent(messages, messageEvent("Corrected.", "pi-2", true))).toEqual(messages);
  });
});
