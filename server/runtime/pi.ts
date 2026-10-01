import {
  createAgentSession,
  ModelRuntime,
  SettingsManager,
  getAgentDir,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";

import type { ChatRuntime, ChatSession, SessionContext } from "./types";
import type { WorkspacePaths } from "../domain/workspace";
import { join } from "node:path";
import { openPiContext, readPiContext, exportPiReference } from "./pi-context";
import { projectPiHistory } from "./pi-history";
import { createWorkspaceResources } from "./resources";

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

/** Adapt Pi without leaking SDK message/context objects into the chat service. */
export function adaptPiSession(
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
  sessionManager: SessionManager,
): ChatSession {
  return {
    get isStreaming() { return session.isStreaming; },
    get messages() { return projectPiHistory(sessionManager.getBranch()).messages; },
    prompt: async (text, run) => {
      if (!run) throw new Error("A Piko Run identity is required.");
      await session.reload();
      // A state-only native entry associates following messages with an execution, without copying text.
      sessionManager.appendCustomEntry("piko-run", { runId: run.id });
      // UI submissions are literal messages, not Pi CLI skill/template commands.
      await session.prompt(text, { expandPromptTemplates: false });
      // An intermediate provider error may be recovered by Pi's automatic retry.
      const last = session.messages.at(-1);
      if (last?.role === "assistant" && last.stopReason === "error") throw new Error(last.errorMessage || "Pi could not complete this reply.");
    },
    abort: () => session.abort(),
    dispose: () => session.dispose(),
    exportState: () => exportPiReference(sessionManager),
    subscribe: (listener) => session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        listener({ type: "delta", text: event.assistantMessageEvent.delta });
      }
    }),
  };
}

export function createPiRuntime(paths: WorkspacePaths): ChatRuntime {
  const modelRuntimePromise = ModelRuntime.create();

  async function createSession(context?: SessionContext): Promise<ChatSession> {
    if (!context) throw new Error("A persistent Piko Thread is required.");
    // Preserve the user's chosen model without inheriting CLI resource or tool settings.
    const profile = SettingsManager.create(paths.state, getAgentDir());
    const { session, sessionManager } = await createPiSession(paths, context, await modelRuntimePromise, profile);
    return adaptPiSession(session, sessionManager);
  }

  return {
    isModelReady: async () => (await modelRuntimePromise).getAvailableSnapshot().length > 0,
    createSession,
    readHistory: (context) => {
      const manager = readPiContext(paths.workspace, join(paths.state, "pi-sessions"), context);
      return projectPiHistory(manager?.getBranch() ?? []);
    },
  };
}
