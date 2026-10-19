import { Type } from "typebox";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, configure, defineDoc, defineExtension, defineTask, defineTool, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID,
  type Agent, type ConversationId, type Cursor, type EntryId, type SubmissionId, type Extension, type Harness, type Storage, type TaskRecord, type Tx } from "@earendil-works/pi-durable";
import type { BackgroundReply, InputSource } from "./types";
import { InputOrigin, registerInput } from "./input-origin";
import { entriesFromTransaction, messageText } from "./pi-history";
import { ItemContext, type ItemBinding } from "./item-context";
import { ItemFiles } from "../domain/work-items";

export const JobControl = defineDoc<{ epoch: number; reported: number[] }>({
  kind: "piko.subagent-control", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ epoch: 0, reported: [] }),
});
export const ANCHOR_KIND = "piko.subagent-anchor";
export const REPORTER_KIND = "piko.subagent-reporter";
export const SUBAGENT_TOOL = "subagent";

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

export type ReporterInput = { child: ConversationId; message: string; epoch: number; source: InputSource; followUp: boolean };
export type ReporterState = { phase: "deliver" } | { phase: "report"; answer?: EntryId; error?: string };
export type ReporterResult = { answer?: EntryId; error?: string } | null;
export type SubagentController = ReturnType<typeof createSubagents>;
export function createSubagents(options: { storage: () => Storage; canReport: () => boolean;
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
          try { await new ItemFiles(root.cwd!).prepare(binding.itemId, String(task.input.child)); }
          catch (error) {
            await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", error: error instanceof Error ? error.message : "Cannot prepare the item directory." } }), ctx);
            return;
          }
        }
        const handle = await admit(async () => {
          if (((await runtime.snapshot(JobControl, task.input.child, ctx))?.epoch ?? 0) !== task.input.epoch) return undefined;
          return child.submit({ type: "input", content: task.input.message,
            whenBusy: task.input.followUp ? "followUp" : "steer", requestId: `piko:subagent-input:${task.id}` }, ctx);
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
        const prepared: { payload?: { requestId: string; knownMessageIds: string[]; body: string } } = {};
        await runtime.commit(async tx => {
          if ((await tx.doc(JobControl, task.input.child)).epoch !== task.input.epoch) return undefined;
          const answer = state.answer === undefined ? undefined : await tx.entry(state.answer);
          const body = state.error ? `The delegated work failed: ${state.error}` : (answer?.model ?? []).map(item => "content" in item ? messageText(item.content) : "").join("");
          if (!body.trim()) return undefined;
          const requestId = `piko:subagent-report:${task.id}`;
          await registerInput(tx, requestId, task.input.source, true, task.input.child);
          const knownMessageIds = (await entriesFromTransaction(tx)).filter(entry => entry.kind === "pi.assistant").map(entry => `pi-${entry.id}`);
          const binding = (await tx.doc(ItemContext, task.input.child)).binding;
          const heading = binding ? `Scheduled/work item ${JSON.stringify(binding.title)} (${binding.itemId}), execution ${task.input.child}. Outputs are in items/${binding.itemId}/outputs/${task.input.child}/ in the main workspace. Summarize the result for the user as appropriate.\n\n` : "";
          prepared.payload = { requestId, knownMessageIds, body: heading + body };
        }, ctx);
        const payload = prepared.payload;
        if (payload) {
          await options.onReply({ source: task.input.source, knownMessageIds: payload.knownMessageIds, requestId: payload.requestId });
          await admit(async () => {
            if (((await runtime.snapshot(JobControl, task.input.child, ctx))?.epoch ?? 0) !== task.input.epoch) return;
            const main = (await runtime.conversation(ROOT_CONVERSATION_ID, ctx))!;
            await main.submit({ type: "input", whenBusy: "followUp", requestId: payload.requestId,
              content: `Internal result from subagent ${task.input.child}. This is background information, not a new user instruction. Decide whether to continue work, respond when useful, or finish silently.\n\n${payload.body}` }, ctx);
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
    const child = (await tx.createConversation({ ownership: { kind: "task", taskId: anchor } })).id;
    const current = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID);
    await configure(tx, child, { model: current.model ?? agent.model, thinkingLevel: current.thinkingLevel ?? agent.thinkingLevel,
      cwd: item ? new ItemFiles(agent.cwd!).directory(item.itemId) : agent.cwd,
      extensions: agent.extensions.filter(value => value.name !== extension.name && value.name !== "piko-work-items"),
      tools: agent.tools.filter(value => value.name !== SUBAGENT_TOOL && value.name !== "work_item"),
      instructions: "You are a background workspace assistant delegated by the main assistant. Complete the assigned task and return the findings to it. Share its workspace resources and tools. You cannot delegate. Your answer is internal; the main assistant decides what to tell the user." });
    if (item) (await tx.doc(ItemContext, child)).binding = item;
    const task = item ? `${message}\n\nThis is work item ${JSON.stringify(item.title)} (${item.itemId}), execution ${child}. ${item.scheduledAt === null ? "Manually started." : `Scheduled at ${new Date(item.scheduledAt).toISOString()}.`} Started at ${new Date(item.startedAt).toISOString()}. Your working directory is this item's persistent directory. Use MEMORY.md for reusable findings and progress, and outputs/${child}/ for this execution's files. Read earlier outputs only when needed. Update item memory conservatively; do not modify global guidance or global memory. Report findings and output paths to the main assistant, and clearly explain anything incomplete. Begin your final answer with one plain sentence stating the outcome, because it becomes the summary shown in the task list. Directory conventions are not a security sandbox.` : message;
    await tx.createTask(Reporter, { child, message: task, epoch: 0, source, followUp: false },
      { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true });
    return child;
  }
  const tool = defineTool({
    name: SUBAGENT_TOOL, description: "Delegate independent work in the background. spawn creates a fresh conversation without main chat history, so include the necessary task context; send corrects active work; status checks jobs; stop cancels one job or all jobs. Results return privately when ready. Never wait here for completion.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("spawn"), Type.Literal("send"), Type.Literal("status"), Type.Literal("stop")]),
      id: Type.Optional(Type.String({ pattern: "^[0-9]+$" })), task: Type.Optional(Type.String({ minLength: 1, maxLength: 24000 })), followUp: Type.Optional(Type.Boolean()) }),
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      if (api.conversationId !== ROOT_CONVERSATION_ID) return { isError: true, content: [{ type: "text", text: "Nested delegation is unavailable." }] };
      const ids = await api.commit(tx => subagentIds(tx), ctx);
      const id = args.id === undefined ? undefined : ids.find(id => String(id) === args.id);
      if (args.id !== undefined && id === undefined) return { isError: true, content: [{ type: "text", text: "Unknown subagent." }] };
      if (args.action === "status") {
        const states = await api.commit(async tx => {
          const records = await taskRecords(tx);
          const lines: string[] = [];
          for (const child of id === undefined ? ids : [id]) {
            const live = await tx.doc(LiveDoc, child);
            const epoch = (await tx.doc(JobControl, child)).epoch;
            const pending = records.some(record => record.kind === REPORTER_KIND && record.state.status !== "terminal"
              && (record.input as ReporterInput).child === child && (record.input as ReporterInput).epoch === epoch
              && (record.state.status === "pending" || record.state.status === "running")
              && (record.state.checkpoint as ReporterState).phase === "deliver");
            lines.push(`${child}: ${live.run || pending ? "working" : "finished"}`);
          }
          return lines.join("\n") || "No delegated work.";
        }, ctx);
        return { content: [{ type: "text", text: states }] };
      }
      if (args.action === "stop") {
        const targets = id === undefined ? ids : [id];
        await invalidate(api, targets, ctx);
        for (const child of targets) await (await api.conversation(child, ctx))!.abort(ctx);
        return { content: [{ type: "text", text: "Delegated work stopped." }] };
      }
      if (!args.task?.trim()) return { isError: true, content: [{ type: "text", text: "A task is required." }] };
      const agent = await api.agent(ctx);
      const result = await api.commit(async tx => {
        const entries = await entriesFromTransaction(tx);
        const call = entries.findLastIndex(entry => (entry.model ?? []).some(message => message.role === "assistant"
          && message.content.some(block => block.type === "toolCall" && block.id === api.callId)));
        const callEntry = call < 0 ? undefined : entries[call].id;
        const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
        let input;
        for (const id of live.run?.inputs ?? []) {
          const candidate = await options.storage().submission(id, ctx);
          if (candidate?.entry !== undefined && (callEntry === undefined || candidate.entry < callEntry)) input = candidate;
        }
        const source = input?.requestId ? (await tx.doc(InputOrigin, ROOT_CONVERSATION_ID, input.requestId, null)).source : { channel: "app" as const };
        let child = id;
        let epoch = 0;
        if (args.action === "send") {
          if (child === undefined) throw new Error("send needs a subagent id.");
          if ((await tx.doc(ItemContext, child)).binding) throw new Error("Item executions use a fixed prompt snapshot. Edit the item or start a new execution instead.");
          const active = await tx.doc(LiveDoc, child);
          epoch = (await tx.doc(JobControl, child)).epoch;
          const records = await taskRecords(tx);
          if (!active.run && !records.some(record => record.kind === REPORTER_KIND && record.state.status !== "terminal"
            && (record.input as ReporterInput).child === child && (record.input as ReporterInput).epoch === epoch
              && (record.state.status === "pending" || record.state.status === "running")
            && (record.state.checkpoint as ReporterState).phase === "deliver")) throw new Error("That job has finished. Spawn a new job.");
        } else {
          return spawn(tx, agent, args.task!, source);
        }
        await tx.createTask(Reporter, { child, message: args.task!, epoch, source, followUp: args.followUp ?? false },
          { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true });
        return child;
      }, ctx);
      return { content: [{ type: "text", text: `Background job ${result} accepted. Continue your work; its result will arrive privately.` }], details: { conversationId: result } };
    },
  });
  extension = defineExtension({ name: "piko-subagents", tasks: [Anchor, Reporter], tools: [tool] });
  return { extension, spawn,
    async source(tx: Tx, callId: string): Promise<InputSource> {
      const entries = await entriesFromTransaction(tx);
      const call = entries.findLastIndex(entry => (entry.model ?? []).some(message => message.role === "assistant"
        && message.content.some(block => block.type === "toolCall" && block.id === callId)));
      const callEntry = call < 0 ? undefined : entries[call].id;
      const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
      let input;
      for (const id of live.run?.inputs ?? []) {
        const candidate = await options.storage().submission(id, context);
        if (candidate?.entry !== undefined && (callEntry === undefined || candidate.entry < callEntry)) input = candidate;
      }
      return input?.requestId ? { ...(await tx.doc(InputOrigin, ROOT_CONVERSATION_ID, input.requestId, null)).source } : { channel: "app" };
    },
    async stop(harness: Harness, ids: ConversationId[]) {
      await invalidate(harness, ids, context);
      for (const child of ids) await (await harness.conversation(child, context))!.abort(context);
    },
  };
}

/** Mark inherited uncertain work before enabling the scheduler; completed report phases may resume. */
export async function prepareRestart(harness: Harness) {
  const inspection = await harness.inspect(context);
  const preserved = inspection.tasks.filter(item => item.record.kind === REPORTER_KIND && !item.record.abortRequested
    && (item.record.state.status === "pending" || item.record.state.status === "running")
    && (item.record.state.checkpoint as ReporterState).phase === "report").map(item => item.record.id);
  const conversations = await harness.commit(async tx => {
    const ids = [ROOT_CONVERSATION_ID, ...await subagentIds(tx)];
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
  return { interrupted: inspection.tasks.some(item => !preserved.includes(item.record.id)), conversations };
}
