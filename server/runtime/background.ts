import { configure, type Agent, type AgentChange, type ConversationId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** The model a background child starts with; Piko resolves it from agent.profiles.background, not from the main selection. */
export type BackgroundSelection = { provider: string; modelId: string; thinkingLevel: ModelThinkingLevel };

/** Without a background profile a child keeps inheriting the main conversation's selection. */
export function backgroundAgent(selection: BackgroundSelection | undefined, parent: Pick<Agent, "model" | "thinkingLevel">) {
  return selection
    ? { model: { provider: selection.provider, modelId: selection.modelId }, thinkingLevel: selection.thinkingLevel }
    : { model: parent.model, thinkingLevel: parent.thinkingLevel };
}

/** Background children never delegate or manage tasks, and never re-enter the curation task. */
const EXCLUDED_TOOL_PREFIXES = ["subagent_", "work_item_"];
const EXCLUDED_EXTENSIONS = ["piko-subagents", "piko-work-items", "piko-memory-curation"];

/** One place for what a background child may inherit from the main agent. */
export function childScope(agent: Agent) {
  return {
    extensions: agent.extensions.filter(value => !EXCLUDED_EXTENSIONS.includes(value.name)),
    tools: agent.tools.filter(value => !EXCLUDED_TOOL_PREFIXES.some(prefix => value.name.startsWith(prefix))),
  };
}

/** Create a task-owned conversation and configure it in the same commit. */
export async function spawnBackgroundChild(tx: Tx, taskId: TaskId, change: Omit<AgentChange, "instructions"> & { instructions: string }): Promise<ConversationId> {
  const child = await tx.createConversation({ ownership: { kind: "task", taskId } });
  await configure(tx, child.id, change);
  return child.id;
}
