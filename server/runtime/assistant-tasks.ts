import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, LiveDoc, ROOT_CONVERSATION_ID,
  type Agent, type ConversationId, type Harness, type Tx } from "@earendil-works/pi-durable";
import type { TaskExecution, AssistantTask, AssistantTaskCommand, AssistantTaskDetail, AssistantTaskDraft, AssistantTaskReceipt } from "../../shared/tasks";
import { TaskFiles, AssistantTaskError, executionId, taskDraft, taskId, latestDue, nextDue } from "../domain/tasks";
import type { InputSource, AssistantTasksRuntime } from "./types";
import { TaskContext, type TaskBinding } from "./task-context";
import { messageText } from "./pi-history";
import { JobControl, REPORTER_KIND, subagentIds, taskRecords, type ReporterInput, type ReporterResult, type ReporterState, type SubagentRuntime } from "./subagent-runtime";

type StoredTask = Omit<AssistantTask, "latest"> & { source: InputSource };
/** once.at is an ISO 8601 instant; the stored shape has no older variant to migrate. */
export const TaskDefinitions = defineDoc<{ items: StoredTask[] }>({
  // Preserve this native kind and payload key; they are durable storage identities, not public names.
  kind: "piko.work-items", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ items: [] }),
});
const Receipts = defineDocFamily<{ hash: string; id: string; executionId: string | null }, null>({
  kind: "piko.item-command", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true,
  initial: () => ({ hash: "", id: "", executionId: null }),
});
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const publicTask = ({ source: _source, ...task }: StoredTask) => plain(task);
async function definitions(tx: Tx) { return (await tx.doc(TaskDefinitions, ROOT_CONVERSATION_ID)).items; }
function find(values: Awaited<ReturnType<typeof definitions>>, id: string) {
  const task = values.find(value => value.id === taskId(id));
  if (!task) throw new AssistantTaskError("Task not found.", 404);
  return task;
}
export class DurableAssistantTasks implements AssistantTasksRuntime {
  private timer?: ReturnType<typeof setInterval>;
  private tickPending?: Promise<void>;
  private closing = false;
  readonly files: TaskFiles;
  constructor(private readonly harness: Harness, workspace: string, private readonly children: SubagentRuntime,
    private readonly ready: () => Promise<void>, private readonly now = Date.now) { this.files = new TaskFiles(workspace); }

  start() {
    if (this.timer) return;
    const tick = () => { void this.tick().catch(error => { if (!this.closing) console.warn("Piko task scheduler:", error instanceof Error ? error.message : "failed"); }); };
    this.timer = setInterval(tick, 1000); this.timer.unref(); tick();
  }
  async close() { this.closing = true; clearInterval(this.timer); this.timer = undefined; await this.tickPending?.catch(() => {}); }

  private async executions(tx: Tx) {
    const records = (await taskRecords(tx)).filter(task => task.kind === REPORTER_KIND);
    const result: { binding: TaskBinding; execution: TaskExecution; message: string; answer: string }[] = [];
    for (const child of await subagentIds(tx)) {
      const binding = (await tx.doc(TaskContext, child)).binding;
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
      // Cancellation invalidates reporting first, but keeps the task occupied until tools actually stop.
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
      return (await definitions(tx)).map(value => {
        const latest = runs.find(run => run.binding.itemId === value.id)?.execution;
        return { ...publicTask(value), ...(latest && { latest }) };
      }).sort((a, b) => b.updatedAt - a.updatedAt);
    }, ctx);
  }
  async detail(id: string, before?: string): Promise<AssistantTaskDetail> {
    return this.harness.commit(async tx => {
      const task = publicTask(find(await definitions(tx), id));
      const all = (await this.executions(tx)).filter(run => run.binding.itemId === id).map(run => run.execution);
      const index = before === undefined ? 0 : all.findIndex(run => run.id === before) + 1;
      if (before !== undefined && index === 0) throw new AssistantTaskError("Unknown execution cursor.");
      const executions = all.slice(index, index + 50);
      return { task: { ...task, ...(all[0] && { latest: all[0] }) }, executions,
        ...(all.length > index + 50 && { nextBefore: executions.at(-1)!.id }) };
    }, ctx);
  }
  private async execution(id: string, runId: string) {
    executionId(runId);
    return this.harness.commit(async tx => {
      find(await definitions(tx), id);
      const run = (await this.executions(tx)).find(value => value.binding.itemId === id && value.execution.id === runId);
      if (!run) throw new AssistantTaskError("Execution not found.", 404);
      return run;
    }, ctx);
  }
  async result(id: string, runId: string) {
    const run = await this.execution(id, runId);
    return { execution: run.execution, answer: run.answer };
  }

  async command(command: AssistantTaskCommand, source: InputSource = { channel: "app" }, signal?: AbortSignal): Promise<AssistantTaskReceipt> {
    signal?.throwIfAborted();
    if (this.closing) throw new AssistantTaskError("Piko is shutting down.", 503);
    const hash = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    // Duplicate checks precede model availability checks: accepted work is always queryable.
    const receipt = async (tx: Tx) => {
      const value = await tx.doc(Receipts, ROOT_CONVERSATION_ID, command.requestId, null);
      if (value.hash && value.hash !== hash) throw new AssistantTaskError("Request identity was already used for a different command.", 409);
      return value;
    };
    const prior = await this.harness.commit(async tx => ({ ...await receipt(tx) }), ctx);
    if (prior.hash) {
      if (command.action === "stop" && prior.executionId) await this.children.stop(this.harness, ROOT_CONVERSATION_ID, [Number(prior.executionId) as ConversationId]);
      return { id: prior.id, ...(prior.executionId && { executionId: prior.executionId }), duplicate: true };
    }
    if (command.action === "run") await this.ready();
    const agent = command.action === "run" ? await (await this.harness.conversation(ROOT_CONVERSATION_ID, ctx))!.agent(ctx) : undefined;
    const draft: AssistantTaskDraft | undefined = command.action === "create" || command.action === "update" ? taskDraft(command.task) : undefined;
    const id = command.action === "create" ? randomUUID() : taskId(command.id);
    if (command.action === "create") await this.files.prepare(id);
    let stopChildren: ConversationId[] = [];
    const result = await this.harness.commit(async tx => {
      signal?.throwIfAborted();
      const saved = await receipt(tx);
      if (saved.hash) {
        if (command.action === "stop" && saved.executionId) stopChildren = [Number(saved.executionId) as ConversationId];
        return { id: saved.id, ...(saved.executionId && { executionId: saved.executionId }), duplicate: true };
      }
      const values = await definitions(tx); const now = this.now();
      let child: ConversationId | undefined;
      if (command.action === "create") {
        values.push({ ...draft!, id, source, status: "active", createdAt: now, updatedAt: now, nextDueAt: nextDue(draft!.schedule, now) });
      } else {
        const task = find(values, id);
        if (command.action === "update") {
          const timingChanged = JSON.stringify(task.schedule) !== JSON.stringify(draft!.schedule);
          Object.assign(task, draft!);
          if (timingChanged) task.nextDueAt = nextDue(task.schedule, now);
          task.updatedAt = now;
        } else if (command.action === "status") {
          if (!["active", "archived"].includes(command.status)) throw new AssistantTaskError("Invalid task status.");
          const active = (await this.executions(tx)).some(run => run.binding.itemId === id && run.execution.status === "running");
          if (command.status === "archived" && active) throw new AssistantTaskError("Stop this task's execution before archiving it.", 409);
          if (task.status !== command.status) {
            task.status = command.status; task.updatedAt = now;
            if (task.status === "active" && task.schedule?.type === "cron") task.nextDueAt = nextDue(task.schedule, now);
          }
        } else if (command.action === "run") {
          if (task.status === "archived") throw new AssistantTaskError("Restore the task before running it.", 409);
          const runs = await this.executions(tx);
          if (runs.some(run => run.binding.itemId === id && run.execution.status === "running")) throw new AssistantTaskError("This task is already running.", 409);
          if (runs.filter(run => run.execution.status === "running").length >= 2) throw new AssistantTaskError("Two tasks are already running. Try again after one finishes.", 409);
          child = await this.spawn(tx, agent!, task, source, null, now);
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
    if (command.action === "stop" && stopChildren.length) await this.children.stop(this.harness, ROOT_CONVERSATION_ID, stopChildren);
    return result;
  }
  source(tx: Tx, callId: string) { return this.children.source(tx, callId); }
  private async spawn(tx: Tx, agent: Agent, task: StoredTask, source: InputSource, scheduledAt: number | null, now: number) {
    return this.children.spawn(tx, agent, task.prompt, source, {
      itemId: task.id, title: task.title, startedAt: now, scheduledAt, interrupted: false,
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
    const due = (await this.harness.snapshot(TaskDefinitions, ROOT_CONVERSATION_ID, ctx))?.items.some(task => task.status === "active" && task.nextDueAt !== null && task.nextDueAt <= this.now());
    if (!due) return;
    await this.ready();
    const agent = await (await this.harness.conversation(ROOT_CONVERSATION_ID, ctx))!.agent(ctx);
    await this.harness.commit(async tx => {
      const now = this.now(); const runs = await this.executions(tx);
      let running = runs.filter(run => run.execution.status === "running").length;
      for (const task of (await definitions(tx)).slice().sort((a, b) => (a.nextDueAt ?? Infinity) - (b.nextDueAt ?? Infinity))) {
        if (task.status !== "active" || !task.schedule || task.nextDueAt === null || task.nextDueAt > now) continue;
        if (runs.some(run => run.binding.itemId === task.id && run.execution.status === "running")) {
          if (task.schedule.type === "cron") task.nextDueAt = nextDue(task.schedule, now);
          continue;
        }
        if (running >= 2) continue;
        const scheduledAt = task.schedule.type === "cron" ? Math.max(task.nextDueAt, latestDue(task.schedule, now)) : task.nextDueAt;
        await this.spawn(tx, agent, task, task.source, scheduledAt, now);
        task.nextDueAt = task.schedule.type === "once" ? null : nextDue(task.schedule, now);
        running++;
      }
    }, ctx);
  }
}
