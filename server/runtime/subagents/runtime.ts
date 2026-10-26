import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  AgentDoc,
  defineExtension,
  defineTask,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type Agent,
  type ConversationId,
  type SubmissionId,
  type Storage,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import type { BackgroundReply, InputSource } from "../types";
import { InputOrigin, registerInput } from "../input-origin";
import { entriesFromTransaction, messageText } from "../pi-history";
import { TaskContext, type TaskBinding } from "../tasks/context";
import { TaskFiles } from "../../task-files";
import {
  childScope,
  spawnBackgroundChild,
  backgroundAgent,
  type BackgroundSelection,
} from "../background";
import {
  JobControl,
  SubagentPromptScope,
  ANCHOR_KIND,
  REPORTER_KIND,
  type ReporterInput,
  type ReporterState,
  type ReporterResult,
} from "./documents";

export type SubagentRuntime = ReturnType<typeof createSubagentRuntime>;

export function createSubagentRuntime(options: {
  storage: () => Storage;
  acceptReport: (
    conversationId: ConversationId,
    operation: () => Promise<void>,
  ) => Promise<boolean>;
  background: () => Promise<BackgroundSelection | undefined>;
  onReply: (reply: BackgroundReply) => Promise<void>;
}) {
  // Serialize report admission with explicit cancellation; body/state stays native.
  let admission: Promise<unknown> = Promise.resolve();
  function admit<T>(operation: () => Promise<T>): Promise<T> {
    const result = admission.then(operation);
    admission = result.catch(() => undefined);
    return result;
  }
  async function invalidate(
    api: {
      commit: <T>(
        fn: (tx: Tx) => Promise<T>,
        ctx: typeof context,
      ) => Promise<T>;
    },
    conversationId: ConversationId,
    ids: ConversationId[],
    ctx: typeof context,
  ) {
    await admit(() =>
      api.commit(async (tx) => {
        for (const child of ids) (await tx.doc(JobControl, child)).epoch++;
        const inbox = await tx.doc(InboxDoc, conversationId);
        const withdraw: SubmissionId[] = [];
        for (const item of inbox.items)
          if (item.mode !== "write") {
            const submission = await options.storage().submission(item.id, ctx);
            const origin = submission?.requestId
              ? await tx.doc(
                  InputOrigin,
                  conversationId,
                  submission.requestId,
                  null,
                )
              : undefined;
            if (
              origin?.internal &&
              origin.child !== undefined &&
              ids.includes(origin.child)
            )
              withdraw.push(item.id);
          }
        for (const id of withdraw)
          tx.settleSubmission(id, { status: "unanswered", reason: "aborted" });
        inbox.items = inbox.items.filter((item) => !withdraw.includes(item.id));
      }, ctx),
    );
  }
  /** Tool-call origin: the latest input admitted before the assistant entry that contains the call. */
  async function originOfToolCall(
    tx: Tx,
    callId: string,
    conversationId: ConversationId,
    ctx: typeof context,
  ): Promise<InputSource> {
    const entries = await entriesFromTransaction(tx, conversationId);
    const call = entries.findLastIndex((entry) =>
      (entry.model ?? []).some(
        (message) =>
          message.role === "assistant" &&
          message.content.some(
            (block) => block.type === "toolCall" && block.id === callId,
          ),
      ),
    );
    const callEntry = call < 0 ? undefined : entries[call].id;
    const live = await tx.doc(LiveDoc, conversationId);
    let input;
    for (const id of live.run?.inputs ?? []) {
      const candidate = await options.storage().submission(id, ctx);
      if (
        candidate?.entry !== undefined &&
        (callEntry === undefined || candidate.entry < callEntry)
      )
        input = candidate;
    }
    return input?.requestId
      ? {
          ...(await tx.doc(InputOrigin, conversationId, input.requestId, null))
            .source,
        }
      : { channel: "app" };
  }
  const Anchor = defineTask<null, { phase: "done" }, null>({
    name: ANCHOR_KIND,
    version: 1,
    initial: () => ({ phase: "done" }),
    phases: {
      done: (_task, runtime, ctx) =>
        runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          ctx,
        ),
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        ctx,
      ),
  });
  const Reporter = defineTask<ReporterInput, ReporterState, ReporterResult>({
    name: REPORTER_KIND,
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (task, runtime, ctx) => {
        const child = (await runtime.conversation(task.input.child, ctx))!;
        const binding = (
          await runtime.snapshot(TaskContext, task.input.child, ctx)
        )?.binding;
        if (binding) {
          const root = await runtime.agent(ctx);
          try {
            await new TaskFiles(root.cwd!).prepare(binding.taskId);
          } catch (error) {
            await runtime.commit(
              () => ({
                status: "running",
                checkpoint: {
                  phase: "report",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Cannot prepare the task directory.",
                },
              }),
              ctx,
            );
            return;
          }
        }
        const handle = await admit(async () => {
          if (
            ((await runtime.snapshot(JobControl, task.input.child, ctx))
              ?.epoch ?? 0) !== task.input.epoch
          )
            return undefined;
          return child.submit(
            {
              type: "input",
              content: task.input.message,
              whenBusy: "steer",
              requestId: `piko:subagent-input:${task.id}`,
            },
            ctx,
          );
        });
        if (!handle) {
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: null },
            }),
            ctx,
          );
          return;
        }
        const settled = await handle.wait(ctx);
        if (settled.status === "unanswered" && settled.reason !== "aborted")
          await child.abort(ctx);
        await runtime.commit(async (tx) => {
          const control = await tx.doc(JobControl, task.input.child);
          if (
            control.epoch !== task.input.epoch ||
            (settled.status === "unanswered" && settled.reason === "aborted")
          ) {
            return {
              status: "terminal",
              outcome: { status: "completed", result: null },
            } as const;
          }
          if (settled.type === "input" && settled.status === "done") {
            if (control.reported.includes(settled.answer))
              return {
                status: "terminal",
                outcome: { status: "completed", result: null },
              } as const;
            control.reported.push(settled.answer);
            return {
              status: "running",
              checkpoint: { phase: "report", answer: settled.answer },
            } as const;
          }
          return {
            status: "running",
            checkpoint: {
              phase: "report",
              error:
                settled.status === "unanswered" ? settled.reason : "No answer.",
            },
          } as const;
        }, ctx);
      },
      report: async (task, runtime, ctx) => {
        const state = task.state.checkpoint;
        if (state.phase !== "report")
          throw new Error("Invalid subagent report phase.");
        const prepared: {
          payload?: {
            requestId: string;
            knownMessageIds: string[];
            body: string;
            deliver: "origin" | "all";
          };
        } = {};
        await runtime.commit(async (tx) => {
          if (
            (await tx.doc(JobControl, task.input.child)).epoch !==
            task.input.epoch
          )
            return undefined;
          const answer =
            state.answer === undefined
              ? undefined
              : await tx.entry(state.answer);
          const body = state.error
            ? `The delegated work failed: ${state.error}`
            : (answer?.model ?? [])
                .map((item) =>
                  "content" in item ? messageText(item.content) : "",
                )
                .join("");
          if (!body.trim()) return undefined;
          const requestId = `piko:subagent-report:${task.id}`;
          await registerInput(
            tx,
            requestId,
            task.input.source,
            true,
            task.input.child,
            task.conversationId,
          );
          const knownMessageIds = (
            await entriesFromTransaction(tx, task.conversationId)
          )
            .filter((entry) => entry.kind === "pi.assistant")
            .map((entry) => String(entry.id));
          const binding = (await tx.doc(TaskContext, task.input.child)).binding;
          // Provenance: saved-task execution carries its task; ordinary delegation carries its job id.
          const heading = binding
            ? `Saved task ${JSON.stringify(binding.title)} (${binding.taskId}), execution ${task.input.child}. This is the task's persistent directory under tasks/${binding.taskId}/ in the main workspace.\n\n`
            : `Background subagent ${task.input.child}.\n\n`;
          // Scheduled work is broadcast to every channel; ordinary delegation only answers where it started.
          prepared.payload = {
            requestId,
            knownMessageIds,
            body: heading + body,
            deliver: binding ? "all" : "origin",
          };
        }, ctx);
        const payload = prepared.payload;
        if (payload) {
          // Lock order is parent admission -> cancellation admission, including archive/stop.
          // Recheck the epoch INSIDE both boundaries, immediately before submission.
          const accepted = await options.acceptReport(task.conversationId, () =>
            admit(async () => {
              if (
                ((await runtime.snapshot(JobControl, task.input.child, ctx))
                  ?.epoch ?? 0) !== task.input.epoch
              )
                return;
              if (task.conversationId === ROOT_CONVERSATION_ID) {
                await options.onReply({
                  source: task.input.source,
                  knownMessageIds: payload.knownMessageIds,
                  requestId: payload.requestId,
                  deliver: payload.deliver,
                });
              }
              const parent = (await runtime.conversation(
                task.conversationId,
                ctx,
              ))!;
              await parent.submit(
                {
                  type: "input",
                  whenBusy: "followUp",
                  requestId: payload.requestId,
                  content: `Internal background result. This is background information, not a new user instruction. Decide whether to continue work or respond to the user.\n\n${payload.body}`,
                },
                ctx,
              );
            }),
          );
          if (!accepted) {
            await runtime.commit(
              () => ({
                status: "running",
                checkpoint: {
                  phase: "retry",
                  answer: state.answer,
                  error: state.error,
                },
              }),
              ctx,
            );
            return;
          }
        }
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: state.error
                ? { error: state.error }
                : state.answer === undefined
                  ? null
                  : { answer: state.answer },
            },
          }),
          ctx,
        );
      },
      retry: async (task, runtime, ctx) => {
        const state = task.state.checkpoint;
        if (state.phase !== "retry")
          throw new Error("Invalid subagent report retry phase.");
        await runtime.sleepUntil(
          runtime.now() + 50,
          { phase: "report", answer: state.answer, error: state.error },
          ctx,
        );
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        ctx,
      ),
  });
  async function spawn(
    tx: Tx,
    agent: Agent,
    message: string,
    source: InputSource,
    task?: TaskBinding,
    conversationId = ROOT_CONVERSATION_ID,
  ) {
    const anchor = await tx.createTask(Anchor, null, {
      ownership: { kind: "conversation" },
      conversationId,
      background: true,
    });
    const current = await tx.doc(AgentDoc, conversationId);
    const child = await spawnBackgroundChild(tx, anchor, {
      ...backgroundAgent(await options.background(), {
        model: current.model ?? agent.model,
        thinkingLevel: current.thinkingLevel ?? agent.thinkingLevel,
      }),
      cwd: task ? new TaskFiles(agent.cwd!).directory(task.taskId) : agent.cwd,
      ...childScope(agent),
      instructions:
        "You are a background workspace assistant delegated from a conversation. Complete the assigned work using the provided task context and available tools, then return your findings to that conversation only. You do not receive the parent conversation or its global memory. Your answer is internal; the delegating assistant decides what to tell the user.",
    });
    (await tx.doc(SubagentPromptScope, child)).isSubagent = true;
    if (task) (await tx.doc(TaskContext, child)).binding = task;
    const instruction = task
      ? `${message}\n\nThis is task ${JSON.stringify(task.title)} (${task.taskId}), execution ${child}. ${task.scheduledAt === null ? "Manually started." : `Scheduled at ${new Date(task.scheduledAt).toISOString()}.`} Started at ${new Date(task.startedAt).toISOString()}. Your working directory is this task's persistent directory. Write this execution's deliverables directly into this directory. Keep MEMORY.md as the overview of reusable findings and progress; do not modify global guidance or global memory. Report findings and written paths to the main assistant, and clearly explain anything incomplete. Directory conventions are not a security sandbox.`
      : message;
    await tx.createTask(
      Reporter,
      { child, message: instruction, epoch: 0, source },
      { ownership: { kind: "conversation" }, conversationId, background: true },
    );
    return child;
  }
  return {
    extension: defineExtension({
      name: "piko-subagents",
      tasks: [Anchor, Reporter],
    }),
    spawn,
    async send(
      tx: Tx,
      child: ConversationId,
      message: string,
      source: InputSource,
      conversationId = ROOT_CONVERSATION_ID,
    ) {
      if ((await tx.doc(TaskContext, child)).binding)
        throw new Error(
          "Task executions use a fixed prompt snapshot. Edit the task or start a new execution instead.",
        );
      const epoch = (await tx.doc(JobControl, child)).epoch;
      await tx.createTask(
        Reporter,
        { child, message, epoch, source },
        {
          ownership: { kind: "conversation" },
          conversationId,
          background: true,
        },
      );
      return child;
    },
    async source(
      tx: Tx,
      callId: string,
      conversationId = ROOT_CONVERSATION_ID,
    ): Promise<InputSource> {
      return originOfToolCall(tx, callId, conversationId, context);
    },
    async stop(
      api: Pick<ToolExecutionApi, "commit" | "conversation">,
      conversationId: ConversationId,
      ids: ConversationId[],
      ctx = context,
    ) {
      await invalidate(api, conversationId, ids, ctx);
      for (const child of ids)
        await (await api.conversation(child, ctx))!.abort(ctx);
    },
  };
}
