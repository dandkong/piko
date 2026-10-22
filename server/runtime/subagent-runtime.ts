import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, defineDoc, defineExtension, defineTask, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID,
  type Agent, type ConversationId, type Cursor, type EntryId, type SubmissionId, type Harness, type Storage, type TaskRecord, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import type { BackgroundReply, InputSource } from "./types";
import { InputOrigin, registerInput } from "./input-origin";
import { entriesFromTransaction, messageText } from "./pi-history";
import { TaskContext, type TaskBinding } from "./task-context";
import { TaskFiles } from "../domain/tasks";
import { childScope, spawnBackgroundChild, backgroundAgent, type BackgroundSelection } from "./background";
import { summarizeToolArgs, toolIcon, singleLine } from "./tool-activity";

export const JobControl = defineDoc<{ epoch: number; reported: number[] }>({
  kind: "piko.subagent-control", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ epoch: 0, reported: [] }),
});
export const ANCHOR_KIND = "piko.subagent-anchor";
export const REPORTER_KIND = "piko.subagent-reporter";

export async function taskRecords(tx: Tx, conversationId = ROOT_CONVERSATION_ID) {
  const records: TaskRecord<unknown, unknown, unknown>[] = []; let cursor: Cursor | undefined;
  do { const page = await tx.scanTasks({ conversationId }, 500, cursor); records.push(...page.items); cursor = page.next; } while (cursor);
  return records;
}
export async function subagentIds(tx: Tx, conversationId = ROOT_CONVERSATION_ID): Promise<ConversationId[]> {
  const anchors = (await taskRecords(tx, conversationId)).filter(task => task.kind === ANCHOR_KIND);
  const result: ConversationId[] = [];
  for (const anchor of anchors) {
    let cursor: Cursor | undefined;
    do { const page = await tx.scanConversations({ ownerTaskId: anchor.id }, 500, cursor); result.push(...page.items.map(item => item.id)); cursor = page.next; } while (cursor);
  }
  return result;
}

/** Only unfinished ordinary delegations; archived side chats leave completed history untouched. */
export async function activeSubagentIds(tx: Tx, conversationId: ConversationId): Promise<ConversationId[]> {
  const records = (await taskRecords(tx, conversationId)).filter(record => record.kind === REPORTER_KIND);
  const active: ConversationId[] = [];
  for (const child of await subagentIds(tx, conversationId)) {
    if ((await tx.doc(TaskContext, child)).binding) continue;
    const live = await tx.doc(LiveDoc, child);
    const reporterPending = records.some(record => (record.input as ReporterInput).child === child && record.state.status !== "terminal");
    if (live.run || reporterPending) active.push(child);
  }
  return active;
}

const ACTIVITY_STEPS = 5;
const ACTIVITY_TEXT_LIMIT = 160;

/** Last assistant text and tool calls of a child, oldest first; bounds both per-step text and step count. */
export async function recentActivity(tx: Tx, child: ConversationId, limit: number): Promise<string[]> {
  const groups: string[][] = [];
  let count = 0;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId: child, order: "descending" }, 50, cursor);
    for (const entry of page.items) {
      if (entry.kind !== "pi.assistant") continue;
      const steps: string[] = [];
      for (const message of entry.model ?? []) {
        if (message.role !== "assistant" || !("content" in message) || !Array.isArray(message.content)) continue;
        for (const block of message.content) {
          if (block.type === "text") {
            const text = singleLine(block.text, ACTIVITY_TEXT_LIMIT);
            if (text) steps.push(text);
          } else if (block.type === "toolCall") {
            const summary = summarizeToolArgs(block.name, block.arguments);
            steps.push(`${toolIcon(block.name)} ${block.name}${summary ? `: ${summary}` : ""}`);
          }
        }
      }
      if (steps.length) { groups.push(steps); count += steps.length; }
      if (count >= limit) break;
    }
    cursor = page.next;
  } while (cursor && count < limit);
  const chrono = groups.reverse().flat();
  // The committed transcript can lag the in-flight answer; show the partial last.
  const live = await tx.doc(LiveDoc, child);
  const partial = live.generation?.message;
  if (partial?.content) {
    const text = partial.content.filter(block => block.type === "text").map(block => block.text).join(" ");
    const line = singleLine(text, ACTIVITY_TEXT_LIMIT);
    if (line) chrono.push(`(replying) ${line}`);
  }
  return chrono.slice(-limit);
}

export type ReporterInput = { child: ConversationId; message: string; epoch: number; source: InputSource };
export type ReporterState = { phase: "deliver" } | { phase: "report"; answer?: EntryId; error?: string };
export type ReporterResult = { answer?: EntryId; error?: string } | null;
export type SubagentRuntime = ReturnType<typeof createSubagentRuntime>;
/** How the child's latest job ended: a run that is gone is stopped, failed, interrupted or finished. */
export async function jobState(tx: Tx, records: TaskRecord<unknown, unknown, unknown>[], child: ConversationId, epoch: number, working: boolean) {
  if (working) return { state: "working" as const };
  const binding = (await tx.doc(TaskContext, child)).binding;
  if (binding?.interrupted) return { state: "interrupted" as const };
  const reporter = records.filter(record => record.kind === REPORTER_KIND
    && (record.input as ReporterInput).child === child).at(-1);
  if (!reporter) return { state: "finished" as const };
  const input = reporter.input as ReporterInput;
  const submission = await tx.submissionByRequest(child, `piko:subagent-input:${reporter.id}`);
  const outcome = reporter.state.status === "terminal" || reporter.state.status === "completing"
    ? reporter.state.outcome : undefined;
  const checkpoint = reporter.state.status === "terminal" || reporter.state.status === "completing"
    ? undefined : reporter.state.checkpoint as ReporterState | undefined;
  if (epoch !== input.epoch || (submission?.status === "unanswered" && submission.reason === "aborted") || outcome?.status === "aborted")
    return { state: "stopped" as const };
  const failure = checkpoint?.phase === "report" ? checkpoint.error
    : submission?.status === "unanswered" ? (typeof submission.detail === "string" ? submission.detail : submission.reason)
    : outcome?.status === "failed" || outcome?.status === "faulted" ? outcome.error.message : undefined;
  return failure ? { state: "failed" as const, detail: singleLine(failure, 80) } : { state: "finished" as const };
}

/** A Reporter still waiting to deliver means the job is working, not finished. */
export function awaitingDelivery(records: TaskRecord<unknown, unknown, unknown>[], child: ConversationId, epoch: number): boolean {
  return records.some(record => record.kind === REPORTER_KIND && record.state.status !== "terminal"
    && (record.input as ReporterInput).child === child && (record.input as ReporterInput).epoch === epoch
    && (record.state.status === "pending" || record.state.status === "running")
    && (record.state.checkpoint as ReporterState).phase === "deliver");
}

export function createSubagentRuntime(options: { storage: () => Storage; canReport: (conversationId: ConversationId) => boolean | Promise<boolean>;
  background: () => Promise<BackgroundSelection | undefined>;
  onReply: (reply: BackgroundReply) => Promise<void> }) {
  // Serialize report admission with explicit cancellation; body/state stays native.
  let admission: Promise<unknown> = Promise.resolve();
  function admit<T>(operation: () => Promise<T>): Promise<T> {
    const result = admission.then(operation); admission = result.catch(() => undefined); return result;
  }
  async function invalidate(api: { commit: <T>(fn: (tx: Tx) => Promise<T>, ctx: typeof context) => Promise<T> }, conversationId: ConversationId, ids: ConversationId[], ctx: typeof context) {
    await admit(() => api.commit(async tx => {
      for (const child of ids) (await tx.doc(JobControl, child)).epoch++;
      const inbox = await tx.doc(InboxDoc, conversationId);
      const withdraw: SubmissionId[] = [];
      for (const item of inbox.items) if (item.mode !== "write") {
        const submission = await options.storage().submission(item.id, ctx);
        const origin = submission?.requestId ? await tx.doc(InputOrigin, conversationId, submission.requestId, null) : undefined;
        if (origin?.internal && origin.child !== undefined && ids.includes(origin.child)) withdraw.push(item.id);
      }
      for (const id of withdraw) tx.settleSubmission(id, { status: "unanswered", reason: "aborted" });
      inbox.items = inbox.items.filter(item => !withdraw.includes(item.id));
    }, ctx));
  }
  /** Tool-call origin: the latest input admitted before the assistant entry that contains the call. */
  async function originOfToolCall(tx: Tx, callId: string, conversationId: ConversationId, ctx: typeof context): Promise<InputSource> {
    const entries = await entriesFromTransaction(tx, conversationId);
    const call = entries.findLastIndex(entry => (entry.model ?? []).some(message => message.role === "assistant"
      && message.content.some(block => block.type === "toolCall" && block.id === callId)));
    const callEntry = call < 0 ? undefined : entries[call].id;
    const live = await tx.doc(LiveDoc, conversationId);
    let input;
    for (const id of live.run?.inputs ?? []) {
      const candidate = await options.storage().submission(id, ctx);
      if (candidate?.entry !== undefined && (callEntry === undefined || candidate.entry < callEntry)) input = candidate;
    }
    return input?.requestId ? { ...(await tx.doc(InputOrigin, conversationId, input.requestId, null)).source } : { channel: "app" };
  }
  const Anchor = defineTask<null, { phase: "done" }, null>({
    name: ANCHOR_KIND, version: 1, initial: () => ({ phase: "done" }), phases: {
      done: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
    }, abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  const Reporter = defineTask<ReporterInput, ReporterState, ReporterResult>({
    name: REPORTER_KIND, version: 1, initial: () => ({ phase: "deliver" }), phases: {
      deliver: async (task, runtime, ctx) => {
        const child = (await runtime.conversation(task.input.child, ctx))!;
        const binding = (await runtime.snapshot(TaskContext, task.input.child, ctx))?.binding;
        if (binding) {
          const root = await runtime.agent(ctx);
          try { await new TaskFiles(root.cwd!).prepare(binding.itemId); }
          catch (error) {
            await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", error: error instanceof Error ? error.message : "Cannot prepare the task directory." } }), ctx);
            return;
          }
        }
        const handle = await admit(async () => {
          if (((await runtime.snapshot(JobControl, task.input.child, ctx))?.epoch ?? 0) !== task.input.epoch) return undefined;
          return child.submit({ type: "input", content: task.input.message,
            whenBusy: "steer", requestId: `piko:subagent-input:${task.id}` }, ctx);
        });
        if (!handle) {
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx); return;
        }
        const settled = await handle.wait(ctx);
        if (settled.status === "unanswered" && settled.reason !== "aborted") await child.abort(ctx);
        await runtime.commit(async tx => {
          const control = await tx.doc(JobControl, task.input.child);
          if (control.epoch !== task.input.epoch || settled.status === "unanswered" && settled.reason === "aborted") {
            return { status: "terminal", outcome: { status: "completed", result: null } } as const;
          }
          if (settled.type === "input" && settled.status === "done") {
            if (control.reported.includes(settled.answer)) return { status: "terminal", outcome: { status: "completed", result: null } } as const;
            control.reported.push(settled.answer);
            return { status: "running", checkpoint: { phase: "report", answer: settled.answer } } as const;
          }
          return { status: "running", checkpoint: { phase: "report", error: settled.status === "unanswered" ? settled.reason : "No answer." } } as const;
        }, ctx);
      },
      report: async (task, runtime, ctx) => {
        while (!(await options.canReport(task.conversationId))) await runtime.sleep(runtime.now() + 50, ctx);
        const state = task.state.checkpoint;
        if (state.phase !== "report") throw new Error("Invalid subagent report phase.");
        const prepared: { payload?: { requestId: string; knownMessageIds: string[]; body: string; deliver: "origin" | "all" } } = {};
        await runtime.commit(async tx => {
          if ((await tx.doc(JobControl, task.input.child)).epoch !== task.input.epoch) return undefined;
          const answer = state.answer === undefined ? undefined : await tx.entry(state.answer);
          const body = state.error ? `The delegated work failed: ${state.error}` : (answer?.model ?? []).map(item => "content" in item ? messageText(item.content) : "").join("");
          if (!body.trim()) return undefined;
          const requestId = `piko:subagent-report:${task.id}`;
          await registerInput(tx, requestId, task.input.source, true, task.input.child, task.conversationId);
          const knownMessageIds = (await entriesFromTransaction(tx, task.conversationId)).filter(entry => entry.kind === "pi.assistant").map(entry => `pi-${entry.id}`);
          const binding = (await tx.doc(TaskContext, task.input.child)).binding;
          // Provenance: saved-task execution carries its task; ordinary delegation carries its job id.
          const heading = binding
            ? `Scheduled task ${JSON.stringify(binding.title)} (${binding.itemId}), execution ${task.input.child}. This is the task's persistent directory under items/${binding.itemId}/ in the main workspace.\n\n`
            : `Background subagent ${task.input.child}.\n\n`;
          // Scheduled work is broadcast to every channel; ordinary delegation only answers where it started.
          prepared.payload = { requestId, knownMessageIds, body: heading + body, deliver: binding ? "all" : "origin" };
        }, ctx);
        const payload = prepared.payload;
        if (payload) {
          if (task.conversationId === ROOT_CONVERSATION_ID) {
            await options.onReply({ source: task.input.source, knownMessageIds: payload.knownMessageIds, requestId: payload.requestId, deliver: payload.deliver });
          }
          await admit(async () => {
            if (((await runtime.snapshot(JobControl, task.input.child, ctx))?.epoch ?? 0) !== task.input.epoch) return;
            const parent = (await runtime.conversation(task.conversationId, ctx))!;
            await parent.submit({ type: "input", whenBusy: "followUp", requestId: payload.requestId,
              content: `Internal background result. This is background information, not a new user instruction. Decide whether to continue work or respond to the user.\n\n${payload.body}` }, ctx);
          });
        }
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed",
          result: state.error ? { error: state.error } : state.answer === undefined ? null : { answer: state.answer } } }), ctx);
      },
    }, abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  async function spawn(tx: Tx, agent: Agent, message: string, source: InputSource, task?: TaskBinding, conversationId = ROOT_CONVERSATION_ID) {
    const anchor = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, conversationId, background: true });
    const current = await tx.doc(AgentDoc, conversationId);
    const child = await spawnBackgroundChild(tx, anchor, {
      ...backgroundAgent(await options.background(), { model: current.model ?? agent.model, thinkingLevel: current.thinkingLevel ?? agent.thinkingLevel }),
      cwd: task ? new TaskFiles(agent.cwd!).directory(task.itemId) : agent.cwd,
      ...childScope(agent),
      instructions: "You are a background workspace assistant delegated from a conversation. Complete the assigned work and return your findings to that conversation only. Share its workspace resources and tools. You cannot delegate. Your answer is internal; the delegating assistant decides what to tell the user." });
    if (task) (await tx.doc(TaskContext, child)).binding = task;
    const instruction = task ? `${message}\n\nThis is task ${JSON.stringify(task.title)} (${task.itemId}), execution ${child}. ${task.scheduledAt === null ? "Manually started." : `Scheduled at ${new Date(task.scheduledAt).toISOString()}.`} Started at ${new Date(task.startedAt).toISOString()}. Your working directory is this task's persistent directory. Write this execution's deliverables directly into this directory. Keep MEMORY.md as the overview of reusable findings and progress; do not modify global guidance or global memory. Report findings and written paths to the main assistant, and clearly explain anything incomplete. Directory conventions are not a security sandbox.` : message;
    await tx.createTask(Reporter, { child, message: instruction, epoch: 0, source },
      { ownership: { kind: "conversation" }, conversationId, background: true });
    return child;
  }
  return { extension: defineExtension({ name: "piko-subagents", tasks: [Anchor, Reporter] }), spawn,
    async send(tx: Tx, child: ConversationId, message: string, source: InputSource, conversationId = ROOT_CONVERSATION_ID) {
      if ((await tx.doc(TaskContext, child)).binding) throw new Error("Task executions use a fixed prompt snapshot. Edit the task or start a new execution instead.");
      const epoch = (await tx.doc(JobControl, child)).epoch;
      await tx.createTask(Reporter, { child, message, epoch, source },
        { ownership: { kind: "conversation" }, conversationId, background: true });
      return child;
    },
    async source(tx: Tx, callId: string, conversationId = ROOT_CONVERSATION_ID): Promise<InputSource> {
      return originOfToolCall(tx, callId, conversationId, context);
    },
    async stop(api: Pick<ToolExecutionApi, "commit" | "conversation">, conversationId: ConversationId, ids: ConversationId[], ctx = context) {
      await invalidate(api, conversationId, ids, ctx);
      for (const child of ids) await (await api.conversation(child, ctx))!.abort(ctx);
    },
  };
}

/** Mark inherited uncertain work before enabling the scheduler; completed report phases may resume. */
export async function prepareRestart(harness: Harness, userConversations: ConversationId[] = [ROOT_CONVERSATION_ID]) {
  const inspection = await harness.inspect(context);
  const preserved = inspection.tasks.filter(item => item.record.kind === REPORTER_KIND && !item.record.abortRequested
    && (item.record.state.status === "pending" || item.record.state.status === "running")
    && (item.record.state.checkpoint as ReporterState).phase === "report").map(item => item.record.id);
  const conversations = await harness.commit(async tx => {
    const children = (await Promise.all(userConversations.map(id => subagentIds(tx, id)))).flat();
    const ids = [...new Set([...userConversations, ...children])];
    for (const item of inspection.tasks) {
      if (item.record.kind === REPORTER_KIND && !preserved.includes(item.record.id)
        && item.record.state.status !== "terminal" && (item.record.state.checkpoint as ReporterState).phase === "deliver") {
        const binding = (await tx.doc(TaskContext, (item.record.input as ReporterInput).child)).binding;
        if (binding) binding.interrupted = true;
      }
    }
    for (const id of ids) {
      const inbox = await tx.doc(InboxDoc, id);
      for (const item of inbox.items) if (item.mode !== "write") tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
      inbox.items = inbox.items.filter(item => item.mode === "write");
    }
    return ids;
  }, context);
  for (const item of inspection.tasks) if (!preserved.includes(item.record.id)) await harness.abortTask(item.record.id, context);
  return { interrupted: inspection.tasks.some(item => !preserved.includes(item.record.id)), conversations,
    interruptedIds: [...new Set(inspection.tasks.filter(item => !preserved.includes(item.record.id)).map(item => item.record.conversationId))] };
}
