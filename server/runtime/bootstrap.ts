import { resolve } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  configure,
  Harness,
  ROOT_CONVERSATION_ID,
  InboxDoc,
  LiveDoc,
  type ConversationId,
  type Registry,
} from "@earendil-works/pi-durable";
import type { WorkspacePaths } from "../workspace";
import { TaskFiles } from "../task-files";
import { openRuntimeStorage } from "./storage";
import { runtimePaths } from "./config/paths";
import { Recovery } from "./conversation-docs";
import { prepareRestart } from "./subagents/recovery";
import { subagentIds } from "./subagents/queries";
import { sideChatScope } from "./background";
import { initializeTaskAgent, markTaskInterrupted } from "./tasks/agent";
import { initializeDelegation } from "./subagents/delegations";
import { initializeAgentResources, workspaceAgentResources } from "./agents/resources";
import {
  requireAvailableModel,
  type WorkspaceModelConfig,
} from "./model-config";
import { sideChats, SIDE_CHAT_INSTRUCTIONS } from "./side-chats";
import { WorkspaceExecutionEnv } from "./execution-env";

/** Finish no-replay recovery and policy refresh before any caller can resume the Harness. */
export async function openRuntime(
  paths: WorkspacePaths,
  config: WorkspaceModelConfig,
  registry: Registry,
) {
  const { storage, persisted, maintenance } = await openRuntimeStorage(runtimePaths(paths.home).sessions);
  let harness: Harness;
  try {
    harness = await Harness.open(
      storage,
      {
        models: config.models,
        registry,
        env: ({ cwd }) =>
          new WorkspaceExecutionEnv(
            cwd ?? paths.workspace,
            runtimePaths(paths.home).tmp,
            paths.home,
          ),
        settings: {
          ...config.harnessSettings,
          toolExecution: "sequential",
          steeringMode: "all",
        },
        onReport: (error) => console.error("Piko durable:", error),
      },
      ctx,
    );
  } catch (error) {
    await storage.close(ctx);
    throw error;
  }
  try {
    await maintenance.recover(harness);
    const existing = await harness.conversation(ROOT_CONVERSATION_ID, ctx);
    if (persisted && !existing)
      throw new Error("Durable root conversation is missing.");
    const preferred = config.main;
    const selected = preferred
      ? await requireAvailableModel(config.models, preferred)
      : (await config.models.getAvailable())[0];
    const root =
      existing ??
      (await harness.root(ctx, {
        agent: {
          cwd: paths.workspace,
          ...(selected && {
            model: { provider: selected.provider, modelId: selected.id },
          }),
          thinkingLevel: preferred?.thinking ?? "off",
        },
      }));
    if (
      existing &&
      resolve((await root.agent(ctx)).cwd ?? paths.workspace) !==
        resolve(paths.workspace)
    )
      throw new Error(
        "The configured workspace differs from the saved conversation.",
      );
    if (selected && !(await root.agent(ctx)).model)
      await root.configure(
        {
          model: { provider: selected.provider, modelId: selected.id },
          thinkingLevel: preferred?.thinking ?? "off",
        },
        ctx,
      );
    const chats = await harness.commit((tx) => sideChats(tx), ctx);
    const chatIds = [
      ROOT_CONVERSATION_ID,
      ...chats.map((chat) => Number(chat.id) as ConversationId),
    ];
    const interrupted: ConversationId[] = [];
    for (const id of chatIds) {
      const live = await harness.snapshot(LiveDoc, id, ctx);
      const inbox = await harness.snapshot(InboxDoc, id, ctx);
      if (live?.run || inbox?.items.some((item) => item.mode !== "write"))
        interrupted.push(id);
    }
    // Apply the no-replay policy before enabling any scheduler or input.
    const recovery = await prepareRestart(harness, chatIds);
    for (const id of recovery.interruptedIds)
      if (!interrupted.includes(id)) interrupted.push(id);
    const rootAgent = await root.agent(ctx);
    await harness.commit(async (tx) => {
      const files = new TaskFiles(paths.workspace);
      for (const owner of chatIds) {
        await initializeAgentResources(tx, owner, workspaceAgentResources(paths.workspace));
        for (const id of await subagentIds(tx, owner)) {
          if (!(await initializeTaskAgent(tx, id, files))) await initializeDelegation(tx, id);
        }
      }
      for (const id of recovery.interruptedChildren) await markTaskInterrupted(tx, id);
      // AgentDoc is already durable. Do not replace per-worker model/cwd/capability choices on restart.
      // Refresh side tools without resetting a side chat's selected model or history.
      for (const chat of chats)
        await configure(tx, Number(chat.id) as ConversationId, {
          cwd: paths.workspace,
          ...sideChatScope(rootAgent),
          instructions: SIDE_CHAT_INSTRUCTIONS,
        });
      for (const id of interrupted) {
        (await tx.doc(Recovery, id)).interruption =
          "The previous work was interrupted by a server restart. Please resend if needed.";
        await tx.appendEntry(id, {
          kind: "piko.interrupted",
          model: [
            {
              role: "user",
              content:
                "The previous work was interrupted. Saved messages are history. Do not resume or repeat tools automatically; act only on new requests.",
              timestamp: Date.now(),
            },
          ],
        });
      }
    }, ctx);
    return { storage, harness, maintenance };
  } catch (error) {
    await harness.close(ctx);
    throw error;
  }
}
