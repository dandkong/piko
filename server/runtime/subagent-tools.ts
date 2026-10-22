import { Type } from "typebox";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, LiveDoc, ROOT_CONVERSATION_ID,
  type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { TaskContext } from "./task-context";
import { requireSideChat } from "./side-chats";
import { JobControl, REPORTER_KIND, subagentIds, taskRecords, jobState, awaitingDelivery, recentActivity,
  type ReporterInput, type SubagentRuntime } from "./subagent-runtime";
import { singleLine } from "./tool-activity";

/** Main-assistant entry points; shared execution lives in subagent-runtime. */
export function createSubagentTools(children: SubagentRuntime) {
  type Command = { action: "spawn"; task: string; id?: never }
    | { action: "send"; id: string; task: string }
    | { action: "status" | "stop"; id: string; task?: never }
    | { action: "list"; id?: never; task?: never };
  const output = (value: object): ToolExecutionResult => ({ output: [{ type: "text", text: JSON.stringify(value) }] });
  const failure = (error: string): ToolExecutionResult => ({ ...output({ status: "error", error }), isError: true });
  // Separate model-facing schemas share the same native execution and cancellation paths.
  const execute = async (args: Command, api: ToolExecutionApi, ctx: Context): Promise<ToolExecutionResult> => {
      const parent = api.conversationId;
      if (parent !== ROOT_CONVERSATION_ID) {
        const sideChat = await api.commit(async tx => {
          try { return (await requireSideChat(tx, String(parent))).id; }
          catch { return undefined; }
        }, ctx);
        if (sideChat !== parent) return failure("Subagents are available only in the main chat and side chats.");
      }
      if (args.action === "list") {
        const subagents = await api.commit(async tx => {
          const records = await taskRecords(tx, parent);
          const values = [];
          for (const child of await subagentIds(tx, parent)) {
            // Saved-task executions belong to task_list/get, not ordinary delegation discovery.
            if ((await tx.doc(TaskContext, child)).binding) continue;
            const first = records.find(record => record.kind === REPORTER_KIND && (record.input as ReporterInput).child === child);
            const live = await tx.doc(LiveDoc, child);
            const epoch = (await tx.doc(JobControl, child)).epoch;
            const state = await jobState(tx, records, child, epoch, !!live.run || awaitingDelivery(records, child, epoch));
            values.push({ id: String(child), task: singleLine(first && (first.input as ReporterInput).message, 160) ?? "",
              status: state.state });
          }
          return values;
        }, ctx);
        return output({ subagents });
      }
      const ids = await api.commit(tx => subagentIds(tx, parent), ctx);
      const id = args.id === undefined ? undefined : ids.find(id => String(id) === args.id);
      if (args.id !== undefined && id === undefined) return failure("Unknown subagent.");
      if (args.action === "status") {
        if (id === undefined) return failure("A subagent id is required.");
        const state = await api.commit(async tx => {
          const records = await taskRecords(tx, parent);
          const live = await tx.doc(LiveDoc, id);
          const epoch = (await tx.doc(JobControl, id)).epoch;
          const status = await jobState(tx, records, id, epoch, !!live.run || awaitingDelivery(records, id, epoch));
          return { id: String(id), status: status.state, ...(status.detail && { detail: status.detail }),
            recentSteps: await recentActivity(tx, id, 5) };
        }, ctx);
        return output(state);
      }
      if (args.action === "stop") {
        if (id === undefined) return failure("A subagent id is required.");
        await children.stop(api, parent, [id], ctx);
        return output({ id: String(id), status: "stopped" });
      }
      if (!args.task?.trim()) return failure("Non-empty instructions are required.");
      const agent = await api.agent(ctx);
      const result = await api.commit(async tx => {
        const source = await children.source(tx, api.callId, parent);
        return args.action === "send"
          ? children.send(tx, id!, args.task!, source, parent)
          : children.spawn(tx, agent, args.task!, source, undefined, parent);
      }, ctx);
      return output({ id: String(result), status: "accepted" });
  };
  const id = Type.String({ pattern: "^[0-9]+$", description: "Job id from subagent_list or subagent_spawn; pass it without '#'." });
  const task = Type.String({ minLength: 1, maxLength: 24000,
    description: "Self-contained instructions with all context needed; the child does not inherit this chat's history." });
  const tools = [
    defineTool({ name: "subagent_list", replay: "unsafe",
      description: "List ordinary subagents with ids, brief tasks and current states. Excludes saved-task executions; no history or steps. Do not poll.",
      parameters: Type.Object({}),
      execute: (_args, api, ctx) => execute({ action: "list" }, api, ctx) }),
    defineTool({ name: "subagent_spawn", replay: "unsafe",
      description: "Delegate independent work to a fresh background subagent. Returns an id immediately; results arrive privately. Continue working; do not poll.",
      parameters: Type.Object({ task }),
      execute: (args, api, ctx) => execute({ action: "spawn", task: args.task }, api, ctx) }),
    defineTool({ name: "subagent_send", replay: "unsafe",
      description: "Send instructions to an existing subagent: steer when busy, continue when idle. Returns immediately. Not available for saved-task executions.",
      parameters: Type.Object({ id, message: Type.String({ minLength: 1, maxLength: 24000, description: "Instructions to add to the existing job." }) }),
      execute: (args, api, ctx) => execute({ action: "send", id: args.id, task: args.message }, api, ctx) }),
    defineTool({ name: "subagent_status", replay: "unsafe",
      description: "Inspect a subagent's state and latest five steps on demand. Do not poll; results arrive automatically.",
      parameters: Type.Object({ id }),
      execute: (args, api, ctx) => execute({ action: "status", id: args.id }, api, ctx) }),
    defineTool({ name: "subagent_stop", replay: "unsafe",
      description: "Cancel a subagent's current work and pending private reports. Keeps its conversation; other jobs continue.",
      parameters: Type.Object({ id }),
      execute: (args, api, ctx) => execute({ action: "stop", id: args.id }, api, ctx) }),
  ];
  return defineExtension({ name: "piko-subagent-tools", tools });
}
