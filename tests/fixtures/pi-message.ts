import type { AssistantMessage } from "@earendil-works/pi-ai";

export function assistant(text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 };
}
