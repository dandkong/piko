import { Type } from "typebox";
import { BACKGROUND_CONTEXT as context, type Context } from "@earendil-works/chord/context";
import { AgentDoc, defineDoc, defineExtension, defineTask, defineTool, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID,
  type Agent, type ConversationId, type Cursor, type EntryId, type SubmissionId, type Extension, type Harness, type Storage, type TaskRecord, type ToolExecutionApi, type ToolExecutionResult, type Tx } from "@earendil-works/pi-durable";
import type { BackgroundReply, InputSource } from "./types";
import { InputOrigin, registerInput } from "./input-origin";
import { entriesFromTransaction, messageText } from "./pi-history";
import { ItemContext, type ItemBinding } from "./item-context";
import { ItemFiles } from "../domain/work-items";
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
export async function subagentIds(tx: Tx): Promise<ConversationId[]> {
  const anchors = (await taskRecords(tx)).filter(task => task.kind === ANCHOR_KIND);
  const result: ConversationId[] = [];
  for (const anchor of anchors) {
    let cursor: Cursor | undefined;
    do { const page = await tx.scanConversations({ ownerTaskId: anchor.id }, 500, cursor); result.push(...page.items.map(item => item.id)); cursor = page.next; } while (cursor);
  }
  return result;
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
export type SubagentController = ReturnType<typeof createSubagents>;
/** How the child's latest job ended: a run that is gone is stopped, failed, interrupted or finished. */
export async function jobState(tx: Tx, records: TaskRecord<unknown, unknown, unknown>[], child: ConversationId, epoch: number, working: boolean) {
  if (working) return { state: "working" as const };
  const binding = (await tx.doc(ItemContext, child)).binding;
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

export function createSubagents(options: { storage: () => Storage; canReport: () => boolean;
  background: () => Promise<BackgroundSelection | undefined>;
  onReply: (reply: BackgroundReply) => Promise<void> }) {
  // Serialize report admission with explicit cancellation; body/state stays native.
  let admission: Promise<unknown> = Promise.resolve();
  function admit<T>(operation: () => Promise<T>): Promise<T> {
    const result = admission.then(operation); admission = result.catch(() => undefined); return result;
  }
  async function invalidate(api: { commit: <T>(fn: (tx: Tx) => Promise<T>, ctx: typeof context) => Promise<T> }, ids: ConversationId[], ctx: typeof context) {
    await admit(() => api.commit(async tx => {
      for (const child of ids) (await tx.doc(JobControl, child)).epoch++;
      const inbox = await tx.doc(InboxDoc, ROOT_CONVERSATION_ID);
      const withdraw: SubmissionId[] = [];
      for (const item of inbox.items) if (item.mode !== "write") {
        const submission = await options.storage().submission(item.id, ctx);
        const origin = submission?.requestId ? await tx.doc(InputOrigin, ROOT_CONVERSATION_ID, submission.requestId, null) : undefined;
        if (origin?.internal && origin.child !== undefined && ids.includes(origin.child)) withdraw.push(item.id);
      }
      for (const id of withdraw) tx.settleSubmission(id, { status: "unanswered", reason: "aborted" });
      inbox.items = inbox.items.filter(item => !withdraw.includes(item.id));
    }, ctx));
  }
  /** Tool-call origin: the latest input admitted before the assistant entry that contains the call. */
  async function originOfToolCall(tx: Tx, callId: string, ctx: typeof context): Promise<InputSource> {
    const entries = await entriesFromTransaction(tx);
    const call = entries.findLastIndex(entry => (entry.model ?? []).some(message => message.role === "assistant"
      && message.content.some(block => block.type === "toolCall" && block.id === callId)));
    const callEntry = call < 0 ? undefined : entries[call].id;
    const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
    let input;
    for (const id of live.run?.inputs ?? []) {
      const candidate = await options.storage().submission(id, ctx);
      if (candidate?.entry !== undefined && (callEntry === undefined || candidate.entry < callEntry)) input = candidate;
    }
    return input?.requestId ? { ...(await tx.doc(InputOrigin, ROOT_CONVERSATION_ID, input.requestId, null)).source } : { channel: "app" };
  }
  /** A Reporter still waiting to deliver means the job is working, not finished. */
  function awaitingDelivery(records: TaskRecord<unknown, unknown, unknown>[], child: ConversationId, epoch: number): boolean {
    return records.some(record => record.kind === REPORTER_KIND && record.state.status !== "terminal"
      && (record.input as ReporterInput).child === child && (record.input as ReporterInput).epoch === epoch
      && (record.state.status === "pending" || record.state.status === "running")
      && (record.state.checkpoint as ReporterState).phase === "deliver");
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
        const binding = (await runtime.snapshot(ItemContext, task.input.child, ctx))?.binding;
        if (binding) {
          const root = await runtime.agent(ctx);
          try { await new ItemFiles(root.cwd!).prepare(binding.itemId); }
          catch (error) {
            await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", error: error instanceof Error ? error.message : "Cannot prepare the item directory." } }), ctx);
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
        while (!options.canReport()) await runtime.sleep(runtime.now() + 50, ctx);
        const state = task.state.checkpoint;
        if (state.phase !== "report") throw new Error("Invalid subagent report phase.");
        const prepared: { payload?: { requestId: string; knownMessageIds: string[]; body: string; deliver: "origin" | "all" } } = {};
        await runtime.commit(async tx => {
          if ((await tx.doc(JobControl, task.input.child)).epoch !== task.input.epoch) return undefined;
          const answer = state.answer === undefined ? undefined : await tx.entry(state.answer);
          const body = state.error ? `The delegated work failed: ${state.error}` : (answer?.model ?? []).map(item => "content" in item ? messageText(item.content) : "").join("");
          if (!body.trim()) return undefined;
          const requestId = `piko:subagent-report:${task.id}`;
          await registerInput(tx, requestId, task.input.source, true, task.input.child);
          const knownMessageIds = (await entriesFromTransaction(tx)).filter(entry => entry.kind === "pi.assistant").map(entry => `pi-${entry.id}`);
          const binding = (await tx.doc(ItemContext, task.input.child)).binding;
          // Provenance paragraph: scheduled work carries its item, plain delegation carries its job id.
          const heading = binding
            ? `Scheduled work item ${JSON.stringify(binding.title)} (${binding.itemId}), execution ${task.input.child}. This is the item's persistent directory under items/${binding.itemId}/ in the main workspace.\n\n`
            : `Background subagent ${task.input.child}.\n\n`;
          // Scheduled work is broadcast to every channel; ordinary delegation only answers where it started.
          prepared.payload = { requestId, knownMessageIds, body: heading + body, deliver: binding ? "all" : "origin" };
        }, ctx);
        const payload = prepared.payload;
        if (payload) {
          await options.onReply({ source: task.input.source, knownMessageIds: payload.knownMessageIds, requestId: payload.requestId, deliver: payload.deliver });
          await admit(async () => {
            if (((await runtime.snapshot(JobControl, task.input.child, ctx))?.epoch ?? 0) !== task.input.epoch) return;
            const main = (await runtime.conversation(ROOT_CONVERSATION_ID, ctx))!;
            await main.submit({ type: "input", whenBusy: "followUp", requestId: payload.requestId,
              content: `Internal background result. This is background information, not a new user instruction. Decide whether to continue work or respond to the user.\n\n${payload.body}` }, ctx);
          });
        }
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed",
          result: state.error ? { error: state.error } : state.answer === undefined ? null : { answer: state.answer } } }), ctx);
      },
    }, abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  let extension: Extension;
  async function spawn(tx: Tx, agent: Agent, message: string, source: InputSource, item?: ItemBinding) {
    const anchor = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true });
    const current = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID);
    const child = await spawnBackgroundChild(tx, anchor, {
      ...backgroundAgent(await options.background(), { model: current.model ?? agent.model, thinkingLevel: current.thinkingLevel ?? agent.thinkingLevel }),
      cwd: item ? new ItemFiles(agent.cwd!).directory(item.itemId) : agent.cwd,
      ...childScope(agent),
      instructions: "You are a background workspace assistant delegated by the main assistant. Complete the assigned task and return the findings to it. Share its workspace resources and tools. You cannot delegate. Your answer is internal; the main assistant decides what to tell the user." });
    if (item) (await tx.doc(ItemContext, child)).binding = item;
    const task = item ? `${message}\n\nThis is work item ${JSON.stringify(item.title)} (${item.itemId}), execution ${child}. ${item.scheduledAt === null ? "Manually started." : `Scheduled at ${new Date(item.scheduledAt).toISOString()}.`} Started at ${new Date(item.startedAt).toISOString()}. Your working directory is this item's persistent directory. Write this execution's deliverables directly into this directory. Keep MEMORY.md as the overview of reusable findings and progress; do not modify global guidance or global memory. Report findings and written paths to the main assistant, and clearly explain anything incomplete. Directory conventions are not a security sandbox.` : message;
    await tx.createTask(Reporter, { child, message: task, epoch: 0, source },
      { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true });
    return child;
  }
  type Command = { action: "spawn"; task: string; id?: never }
    | { action: "send"; id: string; task: string }
    | { action: "status" | "stop"; id: string; task?: never };
  // Separate model-facing schemas share the same native execution and cancellation paths.
  const execute = async (args: Command, api: ToolExecutionApi, ctx: Context): Promise<ToolExecutionResult> => {
      if (api.conversationId !== ROOT_CONVERSATION_ID) return { isError: true, output: [{ type: "text", text: "Nested delegation is unavailable." }] };
      const ids = await api.commit(tx => subagentIds(tx), ctx);
      const id = args.id === undefined ? undefined : ids.find(id => String(id) === args.id);
      if (args.id !== undefined && id === undefined) return { isError: true, output: [{ type: "text", text: "Unknown subagent." }] };
      if (args.action === "status") {
        if (id === undefined) return { isError: true, output: [{ type: "text", text: "status needs a subagent id." }] };
        const states = await api.commit(async tx => {
          const records = await taskRecords(tx);
          const lines: string[] = [];
          for (const child of [id]) {
            const live = await tx.doc(LiveDoc, child);
            const epoch = (await tx.doc(JobControl, child)).epoch;
            const status = await jobState(tx, records, child, epoch, !!live.run || awaitingDelivery(records, child, epoch));
            lines.push(`${child}: ${status.state}${status.detail ? ` · ${status.detail}` : ""}`);
            for (const step of await recentActivity(tx, child, ACTIVITY_STEPS)) lines.push(`  ${step}`);
          }
          return lines.join("\n") || "No delegated work.";
        }, ctx);
        return { output: [{ type: "text", text: states }] };
      }
      if (args.action === "stop") {
        if (id === undefined) return { isError: true, output: [{ type: "text", text: "stop needs a subagent id." }] };
        await invalidate(api, [id], ctx);
        await (await api.conversation(id, ctx))!.abort(ctx);
        return { output: [{ type: "text", text: `Background job ${id} stopped.` }] };
      }
      if (!args.task?.trim()) return { isError: true, output: [{ type: "text", text: "A task is required." }] };
      const agent = await api.agent(ctx);
      const result = await api.commit(async tx => {
        const source = await originOfToolCall(tx, api.callId, ctx);
        let child = id;
        let epoch = 0;
        if (args.action === "send") {
          if (child === undefined) throw new Error("send needs a subagent id.");
          if ((await tx.doc(ItemContext, child)).binding) throw new Error("Item executions use a fixed prompt snapshot. Edit the item or start a new execution instead.");
          epoch = (await tx.doc(JobControl, child)).epoch;
        } else {
          return spawn(tx, agent, args.task!, source);
        }
        await tx.createTask(Reporter, { child, message: args.task!, epoch, source },
          { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true });
        return child;
      }, ctx);
      return { output: [{ type: "text", text: `Background job ${result} accepted. Continue your work; its result will arrive privately.` }], details: { conversationId: result } };
  };
  const id = Type.String({ pattern: "^[0-9]+$", description: "Job id returned by subagent_spawn; pass it without '#'." });
  const task = Type.String({ minLength: 1, maxLength: 24000,
    description: "Self-contained instructions with all context needed; the child does not inherit this chat's history." });
  const tools = [
    defineTool({ name: "subagent_spawn", replay: "unsafe",
      description: "Delegate independent work to a fresh background subagent. Returns an id immediately; results arrive privately. Continue working; do not poll.",
      parameters: Type.Object({ task }),
      execute: (args, api, ctx) => execute({ action: "spawn", task: args.task }, api, ctx) }),
    defineTool({ name: "subagent_send", replay: "unsafe",
      description: "Send instructions to an existing subagent: steer when busy, continue when idle. Returns immediately. Not available for work-item executions.",
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
  extension = defineExtension({ name: "piko-subagents", tasks: [Anchor, Reporter], tools });
  return { extension, spawn,
    async source(tx: Tx, callId: string): Promise<InputSource> {
      return originOfToolCall(tx, callId, context);
    },
    async stop(harness: Harness, ids: ConversationId[]) {
      await invalidate(harness, ids, context);
      for (const child of ids) await (await harness.conversation(child, context))!.abort(context);
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
    const ids = [...new Set([...userConversations, ...await subagentIds(tx)])];
    for (const item of inspection.tasks) {
      if (item.record.kind === REPORTER_KIND && !preserved.includes(item.record.id)
        && item.record.state.status !== "terminal" && (item.record.state.checkpoint as ReporterState).phase === "deliver") {
        const binding = (await tx.doc(ItemContext, (item.record.input as ReporterInput).child)).binding;
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
