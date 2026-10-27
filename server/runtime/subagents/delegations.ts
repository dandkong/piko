import { ROOT_CONVERSATION_ID, type Agent, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { initializeAgentResources, type AgentResourcePolicy } from "../agents/resources";
import { BACKGROUND_AGENT_INSTRUCTIONS, backgroundAgent, childScope, type BackgroundSelection } from "../background";
import { requireSideChat, SideChatError } from "../side-chats";
import { singleLine, DETAIL_TEXT_LIMIT } from "../text";
import type { InputSource } from "../types";
import { BackgroundJob, type BackgroundJobPolicy } from "./documents";
import { backgroundJobs, jobFacts, recentActivity, type JobFacts } from "./queries";
import type { SubagentRuntime } from "./runtime";

const resources: AgentResourcePolicy = { core: false, guidance: false, memory: [], skills: "workspace" };
const policy = (child: ConversationId): BackgroundJobPolicy => ({
  kind: "delegation", continuable: true,
  report: { heading: `Background subagent ${child}.\n\n`, deliver: "origin" },
});

export async function spawnDelegation(tx: Tx, children: SubagentRuntime, agent: Agent,
  selection: BackgroundSelection | undefined, owner: ConversationId, message: string, source: InputSource) {
  const model = backgroundAgent(selection, agent);
  return children.spawn(tx, {
    owner, source, message, policy,
    agent: {
      agent: { ...model, model: model.model ?? null, cwd: agent.cwd!, ...childScope(agent), instructions: BACKGROUND_AGENT_INSTRUCTIONS },
      resources,
    },
  });
}

export async function initializeDelegation(tx: Tx, child: ConversationId) {
  await initializeAgentResources(tx, child, resources);
  (await tx.doc(BackgroundJob, child)).policy ??= policy(child);
}

export async function isUserConversation(tx: Tx, id: ConversationId): Promise<boolean> {
  if (id === ROOT_CONVERSATION_ID) return true;
  try {
    const side = await requireSideChat(tx, String(id));
    return side.metadata.archivedAt === null;
  } catch (error) {
    if (error instanceof SideChatError) return false;
    throw error;
  }
}

function delegationState(facts: JobFacts) {
  if (facts.running || facts.delivering) return { status: "working" as const };
  if (facts.interrupted) return { status: "interrupted" as const };
  if (facts.stopped) return { status: "stopped" as const };
  return facts.error
    ? { status: "failed" as const, detail: singleLine(facts.error, DETAIL_TEXT_LIMIT) }
    : { status: "finished" as const };
}
export async function ownedJobId(tx: Tx, owner: ConversationId, value: string) {
  const jobs = await backgroundJobs(tx, owner);
  for (const child of jobs.children)
    if (String(child) === value && (await tx.doc(BackgroundJob, child)).policy?.kind === "delegation") return child;
  return undefined;
}
export async function listDelegations(tx: Tx, owner: ConversationId) {
  const jobs = await backgroundJobs(tx, owner);
  const values = [];
  for (const child of jobs.children) {
    if ((await tx.doc(BackgroundJob, child)).policy?.kind !== "delegation") continue;
    const facts = await jobFacts(tx, jobs, child);
    values.push({ id: String(child), task: facts.task, status: delegationState(facts).status });
  }
  return values;
}
export async function delegationStatus(tx: Tx, owner: ConversationId, value: string) {
  const jobs = await backgroundJobs(tx, owner);
  const child = jobs.children.find(id => String(id) === value);
  if (child === undefined || (await tx.doc(BackgroundJob, child)).policy?.kind !== "delegation") return undefined;
  return { id: String(child), ...delegationState(await jobFacts(tx, jobs, child)), recentSteps: await recentActivity(tx, child, 5) };
}
