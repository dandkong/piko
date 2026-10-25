import {
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Cursor,
  type TaskRecord,
  type Tx,
} from "@earendil-works/pi-durable";
import { TaskContext } from "../tasks/context";
import {
  JobControl,
  ANCHOR_KIND,
  REPORTER_KIND,
  type ReporterInput,
  type ReporterState,
  type ReporterResult,
} from "./documents";
import { summarizeToolArgs, toolIcon } from "../tool-activity";
import { DETAIL_TEXT_LIMIT, singleLine } from "../text";
import { requireSideChat, SideChatError } from "../side-chats";

export async function taskRecords(
  tx: Tx,
  conversationId = ROOT_CONVERSATION_ID,
) {
  const records: TaskRecord<unknown, unknown, unknown>[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ conversationId }, 500, cursor);
    records.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return records;
}
export async function subagentIds(
  tx: Tx,
  conversationId = ROOT_CONVERSATION_ID,
  records?: TaskRecord<unknown, unknown, unknown>[],
): Promise<ConversationId[]> {
  const anchors = (records ?? (await taskRecords(tx, conversationId))).filter(
    (task) => task.kind === ANCHOR_KIND,
  );
  const result: ConversationId[] = [];
  for (const anchor of anchors) {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanConversations(
        { ownerTaskId: anchor.id },
        500,
        cursor,
      );
      result.push(...page.items.map((item) => item.id));
      cursor = page.next;
    } while (cursor);
  }
  return result;
}

const ACTIVITY_TEXT_LIMIT = DETAIL_TEXT_LIMIT;

/** Last assistant text and tool calls of a child, oldest first; bounds both per-step text and step count. */
export async function recentActivity(
  tx: Tx,
  child: ConversationId,
  limit: number,
): Promise<string[]> {
  const groups: string[][] = [];
  let count = 0;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries(
      { conversationId: child, order: "descending" },
      50,
      cursor,
    );
    for (const entry of page.items) {
      if (entry.kind !== "pi.assistant") continue;
      const steps: string[] = [];
      for (const message of entry.model ?? []) {
        if (
          message.role !== "assistant" ||
          !("content" in message) ||
          !Array.isArray(message.content)
        )
          continue;
        for (const block of message.content) {
          if (block.type === "text") {
            const text = singleLine(block.text, ACTIVITY_TEXT_LIMIT);
            if (text) steps.push(text);
          } else if (block.type === "toolCall") {
            const summary = summarizeToolArgs(block.name, block.arguments);
            steps.push(singleLine(
              `${toolIcon(block.name)} ${block.name}${summary ? `: ${summary}` : ""}`,
              ACTIVITY_TEXT_LIMIT,
            )!);
          }
        }
      }
      if (steps.length) {
        groups.push(steps);
        count += steps.length;
      }
      if (count >= limit) break;
    }
    cursor = page.next;
  } while (cursor && count < limit);
  const chrono = groups.reverse().flat();
  // The committed transcript can lag the in-flight answer; show the partial last.
  const live = await tx.doc(LiveDoc, child);
  const partial = live.generation?.message;
  if (partial?.content) {
    const text = partial.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(" ");
    const line = singleLine(text, ACTIVITY_TEXT_LIMIT);
    if (line) chrono.push(`(replying) ${line}`);
  }
  return chrono.slice(-limit);
}

export async function isUserConversation(
  tx: Tx,
  id: ConversationId,
): Promise<boolean> {
  if (id === ROOT_CONVERSATION_ID) return true;
  try {
    const side = await requireSideChat(tx, String(id));
    return side.metadata.archivedAt === null;
  } catch (error) {
    if (error instanceof SideChatError) return false;
    throw error;
  }
}

/** A transaction-local index; no persisted execution state or cross-transaction cache. */
export async function backgroundJobs(tx: Tx, owner = ROOT_CONVERSATION_ID) {
  const records = await taskRecords(tx, owner);
  const children = await subagentIds(tx, owner, records);
  const reporters = new Map<
    ConversationId,
    TaskRecord<unknown, unknown, unknown>[]
  >();
  for (const record of records) {
    if (record.kind !== REPORTER_KIND) continue;
    const child = (record.input as ReporterInput).child;
    const group = reporters.get(child) ?? [];
    group.push(record);
    reporters.set(child, group);
  }
  return { children, reporters };
}
export type BackgroundJobs = Awaited<ReturnType<typeof backgroundJobs>>;

/** Shared native facts; consumers project their own product states. */
export async function jobFacts(
  tx: Tx,
  jobs: BackgroundJobs,
  child: ConversationId,
) {
  const binding = (await tx.doc(TaskContext, child)).binding;
  const live = await tx.doc(LiveDoc, child);
  const epoch = (await tx.doc(JobControl, child)).epoch;
  const reporters = jobs.reporters.get(child) ?? [];
  const reporter = reporters.at(-1);
  const submission =
    reporter &&
    (await tx.submissionByRequest(child, `piko:subagent-input:${reporter.id}`));
  const outcome =
    reporter &&
    (reporter.state.status === "terminal" ||
      reporter.state.status === "completing")
      ? reporter.state.outcome
      : undefined;
  const checkpoint =
    reporter && (reporter.state.checkpoint as ReporterState | undefined);
  const result =
    outcome?.status === "completed"
      ? (outcome.result as ReporterResult)
      : undefined;
  const error =
    (checkpoint?.phase === "report" ? checkpoint.error : undefined) ??
    result?.error ??
    (submission?.status === "unanswered" && submission.reason !== "aborted"
      ? typeof submission.detail === "string"
        ? submission.detail
        : submission.reason
      : undefined) ??
    (outcome?.status === "failed" || outcome?.status === "faulted"
      ? outcome.error.message
      : undefined);
  const stopped =
    !!reporter &&
    (epoch !== (reporter.input as ReporterInput).epoch ||
      (submission?.status === "unanswered" &&
        submission.reason === "aborted") ||
      outcome?.status === "aborted");
  const delivering = reporters.some(
    (record) =>
      record.state.status !== "terminal" &&
      (record.input as ReporterInput).epoch === epoch &&
      (record.state.status === "pending" ||
        record.state.status === "running") &&
      (record.state.checkpoint as ReporterState).phase === "deliver",
  );
  const answerId =
    submission?.type === "input" && submission.status === "done"
      ? submission.answer
      : checkpoint?.phase === "report"
        ? checkpoint.answer
        : result?.answer;
  return {
    binding: binding && { ...binding },
    running: !!live.run,
    delivering,
    stopped,
    error,
    answerId,
    done: submission?.status === "done",
    hasReporter: !!reporter,
    task:
      singleLine(
        reporters[0] && (reporters[0].input as ReporterInput).message,
        DETAIL_TEXT_LIMIT,
      ) ?? "",
  };
}
export type JobFacts = Awaited<ReturnType<typeof jobFacts>>;
function delegationState(facts: JobFacts) {
  if (facts.running || facts.delivering) return { status: "working" as const };
  if (facts.binding?.interrupted) return { status: "interrupted" as const };
  if (facts.stopped) return { status: "stopped" as const };
  return facts.error
    ? { status: "failed" as const, detail: singleLine(facts.error, DETAIL_TEXT_LIMIT) }
    : { status: "finished" as const };
}
export async function ownedJobId(tx: Tx, owner: ConversationId, value: string) {
  const jobs = await backgroundJobs(tx, owner);
  return jobs.children.find((child) => String(child) === value);
}
export async function listDelegations(tx: Tx, owner: ConversationId) {
  const jobs = await backgroundJobs(tx, owner);
  const values = [];
  for (const child of jobs.children) {
    if ((await tx.doc(TaskContext, child)).binding) continue;
    const facts = await jobFacts(tx, jobs, child);
    values.push({
      id: String(child),
      task: facts.task,
      status: delegationState(facts).status,
    });
  }
  return values;
}
export async function delegationStatus(
  tx: Tx,
  owner: ConversationId,
  value: string,
) {
  const jobs = await backgroundJobs(tx, owner);
  const child = jobs.children.find((child) => String(child) === value);
  if (child === undefined) return undefined;
  return {
    id: String(child),
    ...delegationState(await jobFacts(tx, jobs, child)),
    recentSteps: await recentActivity(tx, child, 5),
  };
}
/** Archive only unfinished ordinary delegations, leaving completed history intact. */
export async function activeSubagentIds(tx: Tx, owner: ConversationId) {
  const jobs = await backgroundJobs(tx, owner);
  const active: ConversationId[] = [];
  for (const child of jobs.children) {
    if ((await tx.doc(TaskContext, child)).binding) continue;
    const live = await tx.doc(LiveDoc, child);
    if (
      live.run ||
      jobs.reporters
        .get(child)
        ?.some((record) => record.state.status !== "terminal")
    )
      active.push(child);
  }
  return active;
}
