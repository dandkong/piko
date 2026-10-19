import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, defineExtension, defineTool, LiveDoc, ROOT_CONVERSATION_ID,
  type Agent, type ConversationId, type Harness, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { ItemExecution, WorkItem, WorkItemCommand, WorkItemDetail, WorkItemDraft, WorkItemReceipt } from "../../shared/work-items";
import { ItemFiles, WorkItemError, executionId, itemDraft, itemId, latestDue, nextDue } from "../domain/work-items";
import type { InputSource, WorkItemsRuntime } from "./types";
import { ItemContext, type ItemBinding } from "./item-context";
import { messageText } from "./pi-history";
import { JobControl, REPORTER_KIND, subagentIds, taskRecords, type ReporterInput, type ReporterResult, type ReporterState, type SubagentController } from "./subagents";

export const WorkItems = defineDoc<{ items: (Omit<WorkItem, "latest"> & { source: InputSource })[] }>({
  kind: "piko.work-items", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ items: [] }),
});
const Receipts = defineDocFamily<{ hash: string; id: string; executionId: string | null }, null>({
  kind: "piko.item-command", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true,
  initial: () => ({ hash: "", id: "", executionId: null }),
});
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const publicItem = ({ source: _source, ...item }: (Awaited<ReturnType<typeof items>>)[number]) => plain(item);
async function items(tx: Tx) { return (await tx.doc(WorkItems, ROOT_CONVERSATION_ID)).items; }
function find(values: Awaited<ReturnType<typeof items>>, id: string) {
  const item = values.find(value => value.id === itemId(id));
  if (!item) throw new WorkItemError("Item not found.", 404);
  return item;
}
function checkRevision(item: WorkItem, revision: number) {
  if (item.revision !== revision) throw new WorkItemError("This item changed. Refresh it before editing.", 409);
}

export class DurableWorkItems implements WorkItemsRuntime {
  private timer?: ReturnType<typeof setInterval>;
  private tickPending?: Promise<void>;
  private closing = false;
  readonly files: ItemFiles;
  constructor(private readonly harness: Harness, workspace: string, private readonly children: SubagentController,
    private readonly ready: () => Promise<void>, private readonly now = Date.now) { this.files = new ItemFiles(workspace); }

  start() {
    if (this.timer) return;
    const tick = () => { void this.tick().catch(error => { if (!this.closing) console.warn("Piko item scheduler:", error instanceof Error ? error.message : "failed"); }); };
    this.timer = setInterval(tick, 1000); this.timer.unref(); tick();
  }
  async close() { this.closing = true; clearInterval(this.timer); this.timer = undefined; await this.tickPending?.catch(() => {}); }

  private async executions(tx: Tx) {
    const records = (await taskRecords(tx)).filter(task => task.kind === REPORTER_KIND);
    const result: { binding: ItemBinding; execution: ItemExecution; message: string; answer: string }[] = [];
    for (const child of await subagentIds(tx)) {
      const binding = (await tx.doc(ItemContext, child)).binding;
      if (!binding) continue;
      const reporters = records.filter(task => (task.input as ReporterInput).child === child);
      const reporter = reporters.at(-1);
      if (!reporter) continue;
      const submission = await tx.submissionByRequest(child, `piko:subagent-input:${reporter.id}`);
      const epoch = (await tx.doc(JobControl, child)).epoch;
      const checkpoint = reporter.state.checkpoint as ReporterState | undefined;
      const outcome = reporter.state.status === "terminal" ? reporter.state.outcome : undefined;
      const reported = outcome?.status === "completed" ? outcome.result as ReporterResult : undefined;
      const failure = checkpoint?.phase === "report" ? checkpoint.error : reported?.error;
      const error = failure ?? (submission?.status === "unanswered" && submission.reason !== "aborted"
        ? (typeof submission.detail === "string" ? submission.detail : submission.reason) : undefined)
        ?? (outcome?.status === "failed" || outcome?.status === "faulted" ? outcome.error.message : undefined);
      const stopped = epoch !== (reporter.input as ReporterInput).epoch || submission?.status === "unanswered" && submission.reason === "aborted" || outcome?.status === "aborted";
      const live = await tx.doc(LiveDoc, child);
      // Cancellation invalidates reporting first, but keeps the item occupied until tools actually stop.
      const status = live.run ? "running" : binding.interrupted ? "interrupted" : stopped ? "stopped" : error ? "failed"
        : submission?.status === "done" ? "completed" : "running";
      const answerId = submission?.type === "input" && submission.status === "done" ? submission.answer
        : checkpoint?.phase === "report" ? checkpoint.answer : reported?.answer;
      const answer = answerId === undefined ? undefined : await tx.entry(answerId);
      const text = (answer?.model ?? []).map(message => "content" in message ? messageText(message.content) : "").join("");
      const preview = text.replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
      result.push({ binding: { ...binding }, execution: { id: String(child), startedAt: binding.startedAt,
        scheduledAt: binding.scheduledAt, revision: binding.revision, status, ...(error && { error }),
        ...(preview && { preview }) },
        message: (reporters[0].input as ReporterInput).message, answer: text });
    }
    return result.reverse();
  }
  async list() {
    return this.harness.commit(async tx => {
      const runs = await this.executions(tx);
      return (await items(tx)).map(value => {
        const latest = runs.find(run => run.binding.itemId === value.id)?.execution;
        return { ...publicItem(value), ...(latest && { latest }) };
      }).sort((a, b) => b.updatedAt - a.updatedAt);
    }, ctx);
  }
  async detail(id: string, before?: string): Promise<WorkItemDetail> {
    return this.harness.commit(async tx => {
      const item = publicItem(find(await items(tx), id));
      const all = (await this.executions(tx)).filter(run => run.binding.itemId === id).map(run => run.execution);
      const index = before === undefined ? 0 : all.findIndex(run => run.id === before) + 1;
      if (before !== undefined && index === 0) throw new WorkItemError("Unknown execution cursor.");
      const executions = all.slice(index, index + 50);
      return { item: { ...item, ...(all[0] && { latest: all[0] }) }, executions,
        ...(all.length > index + 50 && { nextBefore: executions.at(-1)!.id }) };
    }, ctx);
  }
  private async execution(id: string, runId: string) {
    executionId(runId);
    return this.harness.commit(async tx => {
      find(await items(tx), id);
      const run = (await this.executions(tx)).find(value => value.binding.itemId === id && value.execution.id === runId);
      if (!run) throw new WorkItemError("Execution not found.", 404);
      return run;
    }, ctx);
  }
  async result(id: string, runId: string) {
    const run = await this.execution(id, runId);
    return { execution: run.execution, answer: run.answer };
  }

  async command(command: WorkItemCommand, source: InputSource = { channel: "app" }, signal?: AbortSignal): Promise<WorkItemReceipt> {
    signal?.throwIfAborted();
    if (this.closing) throw new WorkItemError("Piko is shutting down.", 503);
    const hash = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    // Duplicate checks precede model availability checks: accepted work is always queryable.
    const receipt = async (tx: Tx) => {
      const value = await tx.doc(Receipts, ROOT_CONVERSATION_ID, command.requestId, null);
      if (value.hash && value.hash !== hash) throw new WorkItemError("Request identity was already used for a different command.", 409);
      return value;
    };
    const prior = await this.harness.commit(async tx => ({ ...await receipt(tx) }), ctx);
    if (prior.hash) {
      if (command.action === "stop" && prior.executionId) await this.children.stop(this.harness, [Number(prior.executionId) as ConversationId]);
      return { id: prior.id, ...(prior.executionId && { executionId: prior.executionId }), duplicate: true };
    }
    if (command.action === "run") await this.ready();
    const agent = command.action === "run" ? await (await this.harness.conversation(ROOT_CONVERSATION_ID, ctx))!.agent(ctx) : undefined;
    const draft: WorkItemDraft | undefined = command.action === "create" || command.action === "update" ? itemDraft(command.item) : undefined;
    const id = command.action === "create" ? randomUUID() : itemId(command.id);
    if (command.action === "create") await this.files.prepare(id);
    const result = await this.harness.commit(async tx => {
      signal?.throwIfAborted();
      const saved = await receipt(tx);
      if (saved.hash) return { id: saved.id, ...(saved.executionId && { executionId: saved.executionId }), duplicate: true };
      const values = await items(tx); const now = this.now();
      let child: ConversationId | undefined;
      if (command.action === "create") {
        values.push({ ...draft!, id, source, status: "active", revision: 1, createdAt: now, updatedAt: now, nextDueAt: nextDue(draft!.schedule, now) });
      } else {
        const item = find(values, id);
        if (command.action === "update") {
          checkRevision(item, command.revision);
          const timingChanged = JSON.stringify(item.schedule) !== JSON.stringify(draft!.schedule);
          Object.assign(item, draft!);
          delete item.autoArchived;
          if (timingChanged) item.nextDueAt = nextDue(item.schedule, now);
          item.revision++; item.updatedAt = now;
        } else if (command.action === "status") {
          checkRevision(item, command.revision);
          if (!["active", "archived"].includes(command.status)) throw new WorkItemError("Invalid item status.");
          const active = (await this.executions(tx)).some(run => run.binding.itemId === id && run.execution.status === "running");
          if (command.status === "archived" && active) throw new WorkItemError("Stop this item's execution before archiving it.", 409);
          if (item.status !== command.status) {
            item.status = command.status; item.revision++; item.updatedAt = now;
            if (command.status === "archived") item.autoArchived = true;
            if (item.status === "active" && item.schedule?.type === "cron") item.nextDueAt = nextDue(item.schedule, now);
          }
        } else if (command.action === "run") {
          if (item.status === "archived") throw new WorkItemError("Restore the item before running it.", 409);
          const runs = await this.executions(tx);
          if (runs.some(run => run.binding.itemId === id && run.execution.status === "running")) throw new WorkItemError("This item is already running.", 409);
          if (runs.filter(run => run.execution.status === "running").length >= 2) throw new WorkItemError("Two items are already running. Try again after one finishes.", 409);
          child = await this.spawn(tx, agent!, item, source, null, now);
        } else {
          const run = (await this.executions(tx)).find(run => run.binding.itemId === id && run.execution.id === command.executionId);
          if (!run) throw new WorkItemError("Execution not found.", 404);
          child = Number(executionId(command.executionId)) as ConversationId;
        }
      }
      signal?.throwIfAborted();
      Object.assign(saved, { hash, id, executionId: child === undefined ? null : String(child) });
      return { id, ...(child !== undefined && { executionId: String(child) }), duplicate: false };
    }, ctx);
    // A stop receipt always targets the original child, so a retry cannot stop a later execution.
    if (command.action === "stop" && result.executionId) await this.children.stop(this.harness, [Number(result.executionId) as ConversationId]);
    return result;
  }
  source(tx: Tx, callId: string) { return this.children.source(tx, callId); }
  private async spawn(tx: Tx, agent: Agent, item: Awaited<ReturnType<typeof items>>[number], source: InputSource, scheduledAt: number | null, now: number) {
    return this.children.spawn(tx, agent, item.prompt, source, {
      itemId: item.id, title: item.title, revision: item.revision, startedAt: now, scheduledAt, interrupted: false,
    });
  }
  /** Public for deterministic tests; the native transaction serializes timer/manual admissions. */
  tick(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.tickPending) return this.tickPending;
    this.tickPending = this.dispatch().then(() => this.archiveCompleted()).finally(() => { this.tickPending = undefined; });
    return this.tickPending;
  }
  /** A finished one-off would otherwise stay active with no next run; failures stay visible. */
  private async archiveCompleted() {
    const pending = (await this.harness.snapshot(WorkItems, ROOT_CONVERSATION_ID, ctx))?.items
      .some(item => item.status === "active" && item.schedule?.type === "once" && item.nextDueAt === null);
    if (!pending) return;
    await this.harness.commit(async tx => {
      const now = this.now(); const runs = await this.executions(tx);
      for (const item of await items(tx)) {
        if (item.status !== "active" || item.schedule?.type !== "once" || item.nextDueAt !== null || item.autoArchived) continue;
        const latest = runs.find(run => run.binding.itemId === item.id);
        if (latest?.execution.status !== "completed") continue;
        item.status = "archived"; item.autoArchived = true; item.revision++; item.updatedAt = now;
      }
    }, ctx);
  }
  private async dispatch() {
    const due = (await this.harness.snapshot(WorkItems, ROOT_CONVERSATION_ID, ctx))?.items.some(item => item.status === "active" && item.nextDueAt !== null && item.nextDueAt <= this.now());
    if (!due) return;
    await this.ready();
    const agent = await (await this.harness.conversation(ROOT_CONVERSATION_ID, ctx))!.agent(ctx);
    await this.harness.commit(async tx => {
      const now = this.now(); const runs = await this.executions(tx);
      let running = runs.filter(run => run.execution.status === "running").length;
      for (const item of (await items(tx)).slice().sort((a, b) => (a.nextDueAt ?? Infinity) - (b.nextDueAt ?? Infinity))) {
        if (item.status !== "active" || !item.schedule || item.nextDueAt === null || item.nextDueAt > now) continue;
        if (runs.some(run => run.binding.itemId === item.id && run.execution.status === "running")) {
          if (item.schedule.type === "cron") item.nextDueAt = nextDue(item.schedule, now);
          continue;
        }
        if (running >= 2) continue;
        const scheduledAt = item.schedule.type === "cron" ? Math.max(item.nextDueAt, latestDue(item.schedule, now)) : item.nextDueAt;
        await this.spawn(tx, agent, item, item.source, scheduledAt, now);
        item.nextDueAt = item.schedule.type === "once" ? null : nextDue(item.schedule, now);
        running++;
      }
    }, ctx);
  }
}

/** UI and main assistant share the same service. Children cannot create schedules or delegate. */
export function createWorkItemTools(service: () => DurableWorkItems) {
  const schedule = Type.Union([Type.Null(), Type.Object({ type: Type.Literal("once"), at: Type.Number() }),
    Type.Object({ type: Type.Literal("cron"), expression: Type.String(), timezone: Type.String() })]);
  return defineExtension({ name: "piko-work-items", tools: [defineTool({
    name: "work_item", replay: "unsafe",
    description: "Manage persistent tasks: one instruction, an optional schedule and a short scheduleText label. list/get inspect tasks; create/update save the instruction, schedule (null=manual, once.at=Unix milliseconds, cron=five fields plus IANA timezone) and scheduleText such as \"每天 9:00\" (shown to the user verbatim: no time zone, no cron syntax); run starts a fresh background assistant; archive stops future triggers and restore re-enables them; stop needs the executionId. Results return privately to you like ordinary subagents; summarize them for the user. Get the current revision before editing. Never claim a schedule ran merely because it exists.",
    parameters: Type.Object({ action: Type.Union(["list", "get", "create", "update", "run", "archive", "restore", "stop"].map(value => Type.Literal(value))),
      id: Type.Optional(Type.String()), title: Type.Optional(Type.String()), prompt: Type.Optional(Type.String()), schedule: Type.Optional(schedule),
      scheduleText: Type.Optional(Type.String()), revision: Type.Optional(Type.Number()), executionId: Type.Optional(Type.String()) }),
    execute: async (args, api, context) => {
      if (api.conversationId !== ROOT_CONVERSATION_ID) throw new WorkItemError("Only the main assistant can manage items.", 403);
      if (args.action === "list") return { content: [{ type: "text", text: JSON.stringify(await service().list()) }] };
      if (args.action === "get") return { content: [{ type: "text", text: JSON.stringify(await service().detail(itemId(args.id))) }] };
      const source = await api.commit(tx => service().source(tx, api.callId), context);
      const requestId = `piko:item-tool:${api.taskId}`;
      let command: WorkItemCommand;
      if (args.action === "create" || args.action === "update") {
        if (args.action === "update" && args.schedule === undefined) throw new WorkItemError("An update requires the current schedule too; use null only for manual execution.");
        const item = itemDraft({ title: args.title, prompt: args.prompt, schedule: args.schedule ?? null, scheduleText: args.scheduleText });
        command = args.action === "create" ? { action: "create", requestId, item }
          : { action: "update", requestId, id: itemId(args.id), revision: args.revision!, item };
      } else if (args.action === "run") command = { action: "run", requestId, id: itemId(args.id) };
      else if (args.action === "stop") command = { action: "stop", requestId, id: itemId(args.id), executionId: executionId(args.executionId) };
      else command = { action: "status", requestId, id: itemId(args.id), revision: args.revision!, status: args.action === "archive" ? "archived" : "active" };
      const result = await service().command(command, source, context.abortSignal);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  })] });
}
