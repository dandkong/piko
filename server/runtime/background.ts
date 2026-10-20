import { configure, type Agent, type AgentChange, type ConversationId, type TaskId, type Tx } from "@earendil-works/pi-durable";

/** Background children never delegate or manage tasks, and never re-enter the curation task. */
const EXCLUDED_TOOLS = ["subagent", "work_item"];
const EXCLUDED_EXTENSIONS = ["piko-subagents", "piko-work-items", "piko-memory-curation"];

/** One place for what a background child may inherit from the main agent. */
export function childScope(agent: Agent) {
  return {
    extensions: agent.extensions.filter(value => !EXCLUDED_EXTENSIONS.includes(value.name)),
    tools: agent.tools.filter(value => !EXCLUDED_TOOLS.includes(value.name)),
  };
}

/** Create a task-owned conversation and configure it in the same commit. */
export async function spawnBackgroundChild(tx: Tx, taskId: TaskId, change: Omit<AgentChange, "instructions"> & { instructions: string }): Promise<ConversationId> {
  const child = await tx.createConversation({ ownership: { kind: "task", taskId } });
  await configure(tx, child.id, change);
  return child.id;
}
