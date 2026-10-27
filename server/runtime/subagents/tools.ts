import { Type } from "typebox";
import type { Context } from "@earendil-works/chord/context";
import {
  defineExtension,
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { SubagentRuntime } from "./runtime";
import type { BackgroundSelection } from "../background";
import {
  isUserConversation,
  listDelegations,
  ownedJobId,
  delegationStatus,
  spawnDelegation,
} from "./delegations";

/** Main-assistant entry points; shared execution lives in subagent-runtime. */
export function createSubagentTools(children: SubagentRuntime, background: () => Promise<BackgroundSelection | undefined>) {
  type Command =
    | { action: "spawn"; task: string; id?: never }
    | { action: "send"; id: string; task: string }
    | { action: "status" | "stop"; id: string; task?: never }
    | { action: "list"; id?: never; task?: never };
  const output = (value: object): ToolExecutionResult => ({
    output: [{ type: "text", text: JSON.stringify(value) }],
  });
  const failure = (error: string): ToolExecutionResult => ({
    ...output({ status: "error", error }),
    isError: true,
  });
  // Separate model-facing schemas share the same native execution and cancellation paths.
  const execute = async (
    args: Command,
    api: ToolExecutionApi,
    ctx: Context,
  ): Promise<ToolExecutionResult> => {
    const parent = api.conversationId;
    if (!(await api.commit((tx) => isUserConversation(tx, parent), ctx)))
      return failure(
        "Subagents are available only in the main chat and side chats.",
      );
    if (args.action === "list")
      return output({
        subagents: await api.commit((tx) => listDelegations(tx, parent), ctx),
      });
    if (args.action === "status") {
      const state = await api.commit(
        (tx) => delegationStatus(tx, parent, args.id),
        ctx,
      );
      return state ? output(state) : failure("Unknown subagent.");
    }
    const id =
      args.id === undefined
        ? undefined
        : await api.commit((tx) => ownedJobId(tx, parent, args.id!), ctx);
    if (args.id !== undefined && id === undefined)
      return failure("Unknown subagent.");
    if (args.action === "stop") {
      if (id === undefined) return failure("A subagent id is required.");
      await children.stop(api, parent, [id], ctx);
      return output({ id: String(id), status: "stopped" });
    }
    if (!args.task?.trim())
      return failure("Non-empty instructions are required.");
    const agent = await api.agent(ctx);
    const selection = args.action === "spawn" ? await background() : undefined;
    const result = await api.commit(async (tx) => {
      const source = await children.source(tx, api.callId, parent);
      return args.action === "send"
        ? children.send(tx, id!, args.task!, source, parent)
        : spawnDelegation(tx, children, agent, selection, parent, args.task!, source);
    }, ctx);
    return output({ id: String(result), status: "accepted" });
  };
  const id = Type.String({
    pattern: "^[0-9]+$",
    description:
      "Job id from subagent_list or subagent_spawn; pass it without '#'.",
  });
  const task = Type.String({
    minLength: 1,
    maxLength: 24000,
    description:
      "Self-contained instructions with all context needed; the child does not inherit this chat's history.",
  });
  const tools = [
    defineTool({
      name: "subagent_list",
      replay: "unsafe",
      description:
        "List ordinary subagents with ids, brief tasks and current states. Excludes saved-task executions; no history or steps.",
      parameters: Type.Object({}),
      execute: (_args, api, ctx) => execute({ action: "list" }, api, ctx),
    }),
    defineTool({
      name: "subagent_spawn",
      replay: "unsafe",
      description:
        "Delegate independent work to a fresh background subagent. Returns an id immediately; results arrive privately.",
      parameters: Type.Object({ task }),
      execute: (args, api, ctx) =>
        execute({ action: "spawn", task: args.task }, api, ctx),
    }),
    defineTool({
      name: "subagent_send",
      replay: "unsafe",
      description:
        "Send instructions to an existing subagent: steer when busy, continue when idle. Returns immediately.",
      parameters: Type.Object({
        id,
        message: Type.String({
          minLength: 1,
          maxLength: 24000,
          description: "Instructions to add to the existing job.",
        }),
      }),
      execute: (args, api, ctx) =>
        execute({ action: "send", id: args.id, task: args.message }, api, ctx),
    }),
    defineTool({
      name: "subagent_status",
      replay: "unsafe",
      description:
        "Inspect a subagent's state and latest five steps on demand.",
      parameters: Type.Object({ id }),
      execute: (args, api, ctx) =>
        execute({ action: "status", id: args.id }, api, ctx),
    }),
    defineTool({
      name: "subagent_stop",
      replay: "unsafe",
      description:
        "Cancel a subagent's current work and pending private reports. Keeps its conversation.",
      parameters: Type.Object({ id }),
      execute: (args, api, ctx) =>
        execute({ action: "stop", id: args.id }, api, ctx),
    }),
  ];
  return defineExtension({ name: "piko-subagent-tools", tools });
}
