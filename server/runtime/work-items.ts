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

type StoredItem = Omit<WorkItem, "latest"> & { source: InputSource };
/** once.at is an ISO 8601 instant; the stored shape has no older variant to migrate. */
export const WorkItems = defineDoc<{ items: StoredItem[] }>({
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
        scheduledAt: binding.scheduledAt, status, ...(error && { error }),
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
    let stopChildren: ConversationId[] = [];
    const result = await this.harness.commit(async tx => {
      signal?.throwIfAborted();
      const saved = await receipt(tx);
      if (saved.hash) {
        if (command.action === "stop" && saved.executionId) stopChildren = [Number(saved.executionId) as ConversationId];
        return { id: saved.id, ...(saved.executionId && { executionId: saved.executionId }), duplicate: true };
      }
      const values = await items(tx); const now = this.now();
      let child: ConversationId | undefined;
      if (command.action === "create") {
        values.push({ ...draft!, id, source, status: "active", createdAt: now, updatedAt: now, nextDueAt: nextDue(draft!.schedule, now) });
      } else {
        const item = find(values, id);
        if (command.action === "update") {
          const timingChanged = JSON.stringify(item.schedule) !== JSON.stringify(draft!.schedule);
          Object.assign(item, draft!);
          if (timingChanged) item.nextDueAt = nextDue(item.schedule, now);
          item.updatedAt = now;
        } else if (command.action === "status") {
          if (!["active", "archived"].includes(command.status)) throw new WorkItemError("Invalid item status.");
          const active = (await this.executions(tx)).some(run => run.binding.itemId === id && run.execution.status === "running");
          if (command.status === "archived" && active) throw new WorkItemError("Stop this item's execution before archiving it.", 409);
          if (item.status !== command.status) {
            item.status = command.status; item.updatedAt = now;
            if (item.status === "active" && item.schedule?.type === "cron") item.nextDueAt = nextDue(item.schedule, now);
          }
        } else if (command.action === "run") {
          if (item.status === "archived") throw new WorkItemError("Restore the item before running it.", 409);
          const runs = await this.executions(tx);
          if (runs.some(run => run.binding.itemId === id && run.execution.status === "running")) throw new WorkItemError("This item is already running.", 409);
          if (runs.filter(run => run.execution.status === "running").length >= 2) throw new WorkItemError("Two items are already running. Try again after one finishes.", 409);
          child = await this.spawn(tx, agent!, item, source, null, now);
        } else {
          stopChildren = (await this.executions(tx))
            .filter(run => run.binding.itemId === id && run.execution.status === "running")
            .map(run => Number(run.execution.id) as ConversationId);
          child = stopChildren[0];
        }
      }
      signal?.throwIfAborted();
      Object.assign(saved, { hash, id, executionId: child === undefined ? null : String(child) });
      return { id, ...(child !== undefined && { executionId: String(child) }), duplicate: false };
    }, ctx);
    // A stop receipt always targets the original child, so a retry cannot stop a later execution.
    if (command.action === "stop" && stopChildren.length) await this.children.stop(this.harness, stopChildren);
    return result;
  }
  source(tx: Tx, callId: string) { return this.children.source(tx, callId); }
  private async spawn(tx: Tx, agent: Agent, item: Awaited<ReturnType<typeof items>>[number], source: InputSource, scheduledAt: number | null, now: number) {
    return this.children.spawn(tx, agent, item.prompt, source, {
      itemId: item.id, title: item.title, startedAt: now, scheduledAt, interrupted: false,
    });
  }
  /** Public for deterministic tests; the native transaction serializes timer/manual admissions. */
  tick(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.tickPending) return this.tickPending;
    this.tickPending = this.dispatch().finally(() => { this.tickPending = undefined; });
    return this.tickPending;
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
  const schedule = Type.Union([Type.Null(), Type.Object({ type: Type.Literal("once"),
    at: Type.String({ description: "ISO 8601 instant with an explicit offset, such as 2026-10-22T09:00:00+08:00." }) }),
    Type.Object({ type: Type.Literal("cron"), expression: Type.String({ description: "Five-field cron expression." }),
      timezone: Type.String({ description: "IANA time zone, such as Asia/Shanghai." }) })],
    { description: "null=manual; once=run once at the given instant; cron=recurring." });
  return defineExtension({ name: "piko-work-items", tools: [defineTool({
    name: "work_item", replay: "unsafe",
    description: "Manage persistent tasks. list: active tasks without prompts; includeArchived also returns archived tasks. get: full definition and the latest 5 executions. create/update: save a complete definition; update replaces title, prompt and schedule, so call get first. schedule null=manual, once.at=ISO 8601 with offset such as 2026-10-22T09:00:00+08:00, cron=five fields plus IANA timezone. scheduleText is shown to the user verbatim and is required whenever schedule is not null. run: start a fresh background assistant now; it does not change the schedule; one execution per task and at most two task executions globally. archive: stop future triggers; stop its running execution first. restore: re-enable future triggers only. stop: cancel any running execution for the task without changing its schedule. Results return privately to you like ordinary subagents; after a task result, your reply may be sent to every channel. Summarize results for the user. Never claim a schedule ran merely because it exists.",
    parameters: Type.Object({
      action: Type.Union(["list", "get", "create", "update", "run", "archive", "restore", "stop"].map(value => Type.Literal(value)),
        { description: "list, get, create, update, run, archive, restore or stop." }),
      id: Type.Optional(Type.String({ description: "Task id. Required for get, update, run, archive, restore and stop; pass it without '#'." })),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: "Required for create and update. Maximum 160 characters." })),
      prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 12000, description: "Required for create and update. Full instruction, maximum 12,000 characters." })),
      schedule: Type.Optional(schedule),
      scheduleText: Type.Optional(Type.String({ maxLength: 120,
        description: "Short human-readable schedule label shown verbatim; required whenever schedule is not null. Do not include a time zone or cron syntax." })),
      includeArchived: Type.Optional(Type.Boolean({ description: "list only: include archived tasks." })),
    }),
    execute: async (args, api, context) => {
      if (api.conversationId !== ROOT_CONVERSATION_ID) throw new WorkItemError("Only the main assistant can manage items.", 403);
      if (args.action === "list") {
        const items = await service().list();
        // Prompt bodies stay out of list output; the tool only needs identity, timing and the last result.
        const summary = items.filter(item => args.includeArchived || item.status === "active").map(item => ({ id: item.id,
          title: item.title, status: item.status, schedule: item.schedule, ...(item.scheduleText && { scheduleText: item.scheduleText }),
          nextDueAt: item.nextDueAt, ...(item.latest && { latest: { status: item.latest.status, startedAt: item.latest.startedAt,
            ...(item.latest.preview && { preview: item.latest.preview }), ...(item.latest.error && { error: item.latest.error }) } }) }));
        return { output: [{ type: "text", text: JSON.stringify(summary) }] };
      }
      if (args.action === "get") {
        const detail = await service().detail(itemId(args.id));
        // Latest executions are enough to report status; full history stays in the app.
        return { output: [{ type: "text", text: JSON.stringify({ item: detail.item, executions: detail.executions.slice(0, 5) }) }] };
      }
      const source = await api.commit(tx => service().source(tx, api.callId), context);
      const requestId = `piko:item-tool:${api.taskId}`;
      let command: WorkItemCommand;
      if (args.action === "create" || args.action === "update") {
        if (args.action === "update" && args.schedule === undefined) throw new WorkItemError("An update replaces the whole definition and requires schedule; use null for manual execution.");
        const item = itemDraft({ title: args.title, prompt: args.prompt, schedule: args.schedule ?? null, scheduleText: args.scheduleText });
        command = args.action === "create" ? { action: "create", requestId, item }
          : { action: "update", requestId, id: itemId(args.id), item };
      } else if (args.action === "run") command = { action: "run", requestId, id: itemId(args.id) };
      else if (args.action === "stop") command = { action: "stop", requestId, id: itemId(args.id) };
      else command = { action: "status", requestId, id: itemId(args.id), status: args.action === "archive" ? "archived" : "active" };
      const result = await service().command(command, source, context.abortSignal);
      return { output: [{ type: "text", text: JSON.stringify(result) }] };
    },
  })] });
}
