import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type Agent,
  type ConversationId,
  type Harness,
  type Tx,
} from "@earendil-works/pi-durable";
import type {
  AssistantTaskCommand,
  AssistantTaskDetail,
  AssistantTaskDraft,
  AssistantTaskReceipt,
} from "../../../shared/tasks";
import {
  AssistantTaskError,
  executionId,
  taskDraft,
  taskId,
  latestDue,
  nextDue,
} from "../../domain/tasks";
import type { InputSource, AssistantTasksRuntime } from "../types";
import { TaskFiles } from "../../task-files";
import type { SubagentRuntime } from "../subagents/runtime";
import {
  activeTaskExecutions,
  latestTaskExecutions,
  taskExecutionPage,
  taskExecutionResult,
} from "./queries";

import { TaskDefinitions, Receipts, type StoredTask } from "./documents";

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const publicTask = ({ source: _source, ...task }: StoredTask) => plain(task);
async function definitions(tx: Tx) {
  return (await tx.doc(TaskDefinitions, ROOT_CONVERSATION_ID)).items;
}
function find(values: Awaited<ReturnType<typeof definitions>>, id: string) {
  const task = values.find((value) => value.id === taskId(id));
  if (!task) throw new AssistantTaskError("Task not found.", 404);
  return task;
}
export class DurableAssistantTasks implements AssistantTasksRuntime {
  private timer?: ReturnType<typeof setInterval>;
  private tickPending?: Promise<void>;
  private closing = false;
  readonly files: TaskFiles;
  constructor(
    private readonly harness: Harness,
    workspace: string,
    private readonly children: SubagentRuntime,
    private readonly ready: () => Promise<void>,
    private readonly now = Date.now,
  ) {
    this.files = new TaskFiles(workspace);
  }

  start() {
    if (this.timer) return;
    const tick = () => {
      void this.tick().catch((error) => {
        if (!this.closing)
          console.warn(
            "Piko task scheduler:",
            error instanceof Error ? error.message : "failed",
          );
      });
    };
    this.timer = setInterval(tick, 1000);
    this.timer.unref();
    tick();
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.tickPending?.catch(() => {});
  }

  async list() {
    return this.harness.commit(async (tx) => {
      const latest = await latestTaskExecutions(tx);
      return (await definitions(tx))
        .map((value) => ({
          ...publicTask(value),
          ...(latest.has(value.id) && { latest: latest.get(value.id) }),
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }, ctx);
  }
  async detail(id: string, before?: string): Promise<AssistantTaskDetail> {
    return this.harness.commit(async (tx) => {
      const task = publicTask(find(await definitions(tx), id));
      const { latest, ...page } = await taskExecutionPage(tx, id, before);
      return { task: { ...task, ...(latest && { latest }) }, ...page };
    }, ctx);
  }
  async result(id: string, runId: string) {
    executionId(runId);
    return this.harness.commit(async (tx) => {
      find(await definitions(tx), id);
      return taskExecutionResult(tx, id, runId);
    }, ctx);
  }

  async command(
    command: AssistantTaskCommand,
    source: InputSource = { channel: "app" },
    signal?: AbortSignal,
  ): Promise<AssistantTaskReceipt> {
    signal?.throwIfAborted();
    if (this.closing)
      throw new AssistantTaskError("Piko is shutting down.", 503);
    const hash = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex");
    // Duplicate checks precede model availability checks: accepted work is always queryable.
    const receipt = async (tx: Tx) => {
      const value = await tx.doc(
        Receipts,
        ROOT_CONVERSATION_ID,
        command.requestId,
        null,
      );
      if (value.hash && value.hash !== hash)
        throw new AssistantTaskError(
          "Request identity was already used for a different command.",
          409,
        );
      return value;
    };
    const prior = await this.harness.commit(
      async (tx) => ({ ...(await receipt(tx)) }),
      ctx,
    );
    if (prior.hash) {
      if (command.action === "stop" && prior.executionId)
        await this.children.stop(this.harness, ROOT_CONVERSATION_ID, [
          Number(prior.executionId) as ConversationId,
        ]);
      return {
        id: prior.id,
        ...(prior.executionId && { executionId: prior.executionId }),
        duplicate: true,
      };
    }
    if (command.action === "run") await this.ready();
    const agent =
      command.action === "run"
        ? await (await this.harness.conversation(
            ROOT_CONVERSATION_ID,
            ctx,
          ))!.agent(ctx)
        : undefined;
    const draft: AssistantTaskDraft | undefined =
      command.action === "create" || command.action === "update"
        ? taskDraft(command.task)
        : undefined;
    const id = command.action === "create" ? randomUUID() : taskId(command.id);
    if (command.action === "create") await this.files.prepare(id);
    let stopChildren: ConversationId[] = [];
    const result = await this.harness.commit(async (tx) => {
      signal?.throwIfAborted();
      const saved = await receipt(tx);
      if (saved.hash) {
        if (command.action === "stop" && saved.executionId)
          stopChildren = [Number(saved.executionId) as ConversationId];
        return {
          id: saved.id,
          ...(saved.executionId && { executionId: saved.executionId }),
          duplicate: true,
        };
      }
      const values = await definitions(tx);
      const now = this.now();
      let child: ConversationId | undefined;
      if (command.action === "create") {
        values.push({
          ...draft!,
          id,
          source,
          status: "active",
          createdAt: now,
          updatedAt: now,
          nextDueAt: nextDue(draft!.schedule, now),
        });
      } else {
        const task = find(values, id);
        if (command.action === "update") {
          const timingChanged =
            JSON.stringify(task.schedule) !== JSON.stringify(draft!.schedule);
          Object.assign(task, draft!);
          if (timingChanged) task.nextDueAt = nextDue(task.schedule, now);
          task.updatedAt = now;
        } else if (command.action === "status") {
          if (!["active", "archived"].includes(command.status))
            throw new AssistantTaskError("Invalid task status.");
          const active = (await activeTaskExecutions(tx)).some(
            (run) =>
              run.binding.itemId === id && run.execution.status === "running",
          );
          if (command.status === "archived" && active)
            throw new AssistantTaskError(
              "Stop this task's execution before archiving it.",
              409,
            );
          if (task.status !== command.status) {
            task.status = command.status;
            task.updatedAt = now;
            if (task.status === "active" && task.schedule?.type === "cron")
              task.nextDueAt = nextDue(task.schedule, now);
          }
        } else if (command.action === "run") {
          if (task.status === "archived")
            throw new AssistantTaskError(
              "Restore the task before running it.",
              409,
            );
          const runs = await activeTaskExecutions(tx);
          if (
            runs.some(
              (run) =>
                run.binding.itemId === id && run.execution.status === "running",
            )
          )
            throw new AssistantTaskError("This task is already running.", 409);
          if (
            runs.filter((run) => run.execution.status === "running").length >= 2
          )
            throw new AssistantTaskError(
              "Two tasks are already running. Try again after one finishes.",
              409,
            );
          child = await this.spawn(tx, agent!, task, source, null, now);
        } else {
          stopChildren = (await activeTaskExecutions(tx))
            .filter(
              (run) =>
                run.binding.itemId === id && run.execution.status === "running",
            )
            .map((run) => Number(run.execution.id) as ConversationId);
          child = stopChildren[0];
        }
      }
      signal?.throwIfAborted();
      Object.assign(saved, {
        hash,
        id,
        executionId: child === undefined ? null : String(child),
      });
      return {
        id,
        ...(child !== undefined && { executionId: String(child) }),
        duplicate: false,
      };
    }, ctx);
    // A stop receipt always targets the original child, so a retry cannot stop a later execution.
    if (command.action === "stop" && stopChildren.length)
      await this.children.stop(
        this.harness,
        ROOT_CONVERSATION_ID,
        stopChildren,
      );
    return result;
  }
  source(tx: Tx, callId: string) {
    return this.children.source(tx, callId);
  }
  private async spawn(
    tx: Tx,
    agent: Agent,
    task: StoredTask,
    source: InputSource,
    scheduledAt: number | null,
    now: number,
  ) {
    return this.children.spawn(tx, agent, task.prompt, source, {
      itemId: task.id,
      title: task.title,
      startedAt: now,
      scheduledAt,
      interrupted: false,
    });
  }
  /** Public for deterministic tests; the native transaction serializes timer/manual admissions. */
  tick(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.tickPending) return this.tickPending;
    this.tickPending = this.dispatch().finally(() => {
      this.tickPending = undefined;
    });
    return this.tickPending;
  }
  private async dispatch() {
    const due = (
      await this.harness.snapshot(TaskDefinitions, ROOT_CONVERSATION_ID, ctx)
    )?.items.some(
      (task) =>
        task.status === "active" &&
        task.nextDueAt !== null &&
        task.nextDueAt <= this.now(),
    );
    if (!due) return;
    await this.ready();
    const agent = await (await this.harness.conversation(
      ROOT_CONVERSATION_ID,
      ctx,
    ))!.agent(ctx);
    await this.harness.commit(async (tx) => {
      const now = this.now();
      const runs = await activeTaskExecutions(tx);
      let running = runs.filter(
        (run) => run.execution.status === "running",
      ).length;
      for (const task of (await definitions(tx))
        .slice()
        .sort(
          (a, b) => (a.nextDueAt ?? Infinity) - (b.nextDueAt ?? Infinity),
        )) {
        if (
          task.status !== "active" ||
          !task.schedule ||
          task.nextDueAt === null ||
          task.nextDueAt > now
        )
          continue;
        if (
          runs.some(
            (run) =>
              run.binding.itemId === task.id &&
              run.execution.status === "running",
          )
        ) {
          if (task.schedule.type === "cron")
            task.nextDueAt = nextDue(task.schedule, now);
          continue;
        }
        if (running >= 2) continue;
        const scheduledAt =
          task.schedule.type === "cron"
            ? Math.max(task.nextDueAt, latestDue(task.schedule, now))
            : task.nextDueAt;
        await this.spawn(tx, agent, task, task.source, scheduledAt, now);
        task.nextDueAt =
          task.schedule.type === "once" ? null : nextDue(task.schedule, now);
        running++;
      }
    }, ctx);
  }
}
