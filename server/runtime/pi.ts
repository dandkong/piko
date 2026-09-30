import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import type { Message } from "../../shared/chat";
import type { ChatRuntime, ChatSession } from "./types";

type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

function sessionMessages(session: PiSession): Message[] {
  return session.messages.flatMap((message, index) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const content = messageText(message.content);
    if (!content.trim()) return [];
    return [
      {
        id: "id" in message && typeof message.id === "string" ? message.id : `${index}`,
        role: message.role,
        content,
        createdAt: "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : Date.now(),
      },
    ];
  });
}

export function createPiRuntime(): ChatRuntime {
  const modelRuntimePromise = ModelRuntime.create();

  async function createSession(): Promise<ChatSession> {
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: [
        "You are Piko, a thoughtful personal assistant.",
        "Be warm, clear, and concise. Help the person think, plan, and write.",
        "You have no tools and no access to their files, accounts, or the internet.",
        "Never claim you completed an action or accessed information you could not reach.",
      ].join("\n"),
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      modelRuntime: await modelRuntimePromise,
      sessionManager: SessionManager.inMemory(),
      resourceLoader,
      noTools: "all",
      tools: [],
    });
    if (!session.model) {
      session.dispose();
      throw new Error("No Pi model is configured. Run `pi` and finish setting up a provider and model.");
    }
    return {
      get isStreaming() { return session.isStreaming; },
      get messages() { return sessionMessages(session); },
      prompt: (text) => session.prompt(text),
      abort: () => session.abort(),
      dispose: () => session.dispose(),
      subscribe: (listener) => session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          listener({ type: "delta", text: event.assistantMessageEvent.delta });
        } else if (event.type === "message_end" && event.message.role === "assistant") {
          const result = event.message;
          if (result.stopReason === "error") {
            listener({ type: "error", message: result.errorMessage || "Pi could not complete this reply." });
          }
        }
      }),
    };
  }

  return {
    isModelReady: async () => (await modelRuntimePromise).getAvailableSnapshot().length > 0,
    createSession,
  };
}
