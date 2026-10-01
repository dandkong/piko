import {
  createAgentSession,
  ModelRuntime,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

import type { Message } from "../../shared/chat";
import type { ChatRuntime, ChatSession, SessionContext } from "./types";
import type { WorkspacePaths } from "../domain/workspace";
import { join } from "node:path";
import { openPiContext, exportPiCheckpoint } from "./pi-context";
import { createWorkspaceResources } from "./resources";

type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export const PIKO_TOOL_NAMES = ["read", "write", "edit", "bash"];

/** Bind the selected built-in tools and controlled resources to the assistant's workspace. */
export async function createPiSession(paths: WorkspacePaths, context: SessionContext, modelRuntime: ModelRuntime, profile: SettingsManager) {
  const { loader: resourceLoader, settingsManager } = createWorkspaceResources(paths, {
    defaultProvider: profile.getDefaultProvider(), defaultModel: profile.getDefaultModel(),
    defaultThinkingLevel: profile.getDefaultThinkingLevel(),
  });
  await resourceLoader.reload();
  for (const diagnostic of resourceLoader.getSkills().diagnostics) console.warn("Piko skill:", diagnostic.message, diagnostic.path);
  const sessionManager = openPiContext(paths.workspace, join(paths.state, "pi-sessions"), context);
  const { session } = await createAgentSession({
    modelRuntime, cwd: paths.workspace, sessionManager, settingsManager, resourceLoader,
    tools: PIKO_TOOL_NAMES,
  });
  if (!session.model) {
    session.dispose();
    throw new Error("No Pi model is configured. Run `pi` and finish setting up a provider and model.");
  }
  return { session, sessionManager };
}

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

export function createPiRuntime(paths: WorkspacePaths): ChatRuntime {
  const modelRuntimePromise = ModelRuntime.create();

  async function createSession(context?: SessionContext): Promise<ChatSession> {
    if (!context) throw new Error("A persistent Piko Thread is required.");
    // Preserve the user's chosen model without inheriting CLI resource or tool settings.
    const profile = SettingsManager.create(paths.state, getAgentDir());
    const { session, sessionManager } = await createPiSession(paths, context, await modelRuntimePromise, profile);
    return {
      get isStreaming() { return session.isStreaming; },
      get messages() { return sessionMessages(session); },
      prompt: async (text) => {
        await session.reload();
        await session.prompt(text);
        // An intermediate provider error may be recovered by Pi's automatic retry.
        const last = session.messages.at(-1);
        if (last?.role === "assistant" && last.stopReason === "error") throw new Error(last.errorMessage || "Pi could not complete this reply.");
      },
      abort: () => session.abort(),
      dispose: () => session.dispose(),
      exportState: () => exportPiCheckpoint(sessionManager),
      subscribe: (listener) => session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          listener({ type: "delta", text: event.assistantMessageEvent.delta });
        }
      }),
    };
  }

  return {
    isModelReady: async () => (await modelRuntimePromise).getAvailableSnapshot().length > 0,
    createSession,
  };
}
