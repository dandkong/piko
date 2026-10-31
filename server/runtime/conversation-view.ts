import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  InboxDoc,
  LiveDoc,
  watchEvents,
  type AgentEvent,
  type AgentEventStream,
  type Conversation,
  type EntryRecord,
  type SubmissionRecord,
  type Storage,
  type Cursor,
  type Harness,
} from "@earendil-works/pi-durable";
import type { ChatUsage } from "../../shared/chat";
import type { SessionEvent } from "./types";
import { summarizeToolArgs } from "./tool-activity";
import { CompactionObserver } from "./compactions";
import { ConversationActivityProjection } from "./conversation-activity";
import {
  entriesFromTransaction,
  historyPageFromTransaction,
  inputsFromStorage,
  messageText,
  projectPiHistory,
  historyAroundPiMessage,
  searchPiHistory,
  readPiEntries,
  readPiInputs,
} from "./pi-history";
import { PiMessageEvents } from "./pi-events";
import { internalInput } from "./input-origin";
import type { WorkspaceModelConfig } from "./model-config";
import { Recovery } from "./conversation-docs";
import { logError, logInfo, logWarn } from "../logging";

export function submissionReceipt(
  record: SubmissionRecord,
): import("../../shared/chat").SubmissionReceipt {
  return {
    id: String(record.id),
    ...(record.requestId && { requestId: record.requestId }),
    status: record.status,
    ...(record.status === "unanswered" && {
      error: typeof record.detail === "string" ? record.detail : record.reason,
    }),
  };
}

/** Read/display projection. Never starts or stops work and never closes the Harness. */
export class ConversationView {
  private compactions!: CompactionObserver;
  private entries: EntryRecord[] = [];
  private inputEntries = new Map<number, string>();
  private hiddenEntries = new Set<number>();
  private unsubscribeBindings?: () => void;
  private eventStream!: AgentEventStream;
  private delivery?: Promise<void>;
  private output = new PiMessageEvents((event) => this.emit(event));
  private previousIds = new Map<string, string>();
  private readonly contextWindows = new Map<string, number>();
  selected?: { provider: string; modelId: string };
  private readonly toolCalls = new Map<
    string,
    { name: string; summary: string; startedAt: number }
  >();
  private runStartedAt?: number;
  private readonly liveActivity = new ConversationActivityProjection(activity => this.emit({ type: "activity", activity }));
  observationError?: Error;

  constructor(
    private readonly harness: Harness,
    private readonly storage: Storage,
    private readonly conversation: Conversation,
    private readonly config: WorkspaceModelConfig,
    private readonly publish: (event: SessionEvent) => void,
    private readonly activity: (running: boolean, boundary: boolean) => void,
    private readonly isBusy: () => boolean,
    private readonly isClosed: () => boolean,
  ) {}
  get messages() {
    const messages = projectPiHistory(
      this.entries,
      this.inputEntries,
      this.hiddenEntries,
    ).messages;
    const partial = this.output.partial(this.entries);
    return partial?.content.trim() ? [...messages, partial] : messages;
  }
  async init(): Promise<void> {
    const { harness, storage, conversation } = this;
    this.compactions = new CompactionObserver(
      harness,
      (event) => this.emit(event),
      () => this.emit({ type: "invalidated" }),
    );
    const agent = await conversation.agent(ctx);
    this.selected = agent.model && {
      provider: agent.model.provider,
      modelId: agent.model.modelId,
    };
    for (const model of await this.config.models.getAvailable())
      this.contextWindows.set(
        `${model.provider}/${model.id}`,
        model.contextWindow,
      );
    const stream = (this.eventStream = await watchEvents(
      harness,
      conversation.id,
      ctx,
    ));
    this.entries = await readPiEntries(harness, conversation.id);
    this.inputEntries = await readPiInputs(harness, storage, conversation.id);
    this.hiddenEntries = await harness.commit(async (tx) => {
      const hidden = new Set<number>();
      for (const [entry, requestId] of this.inputEntries)
        if (await internalInput(tx, requestId, conversation.id))
          hidden.add(entry);
      return hidden;
    }, ctx);
    this.unsubscribeBindings = harness.subscribeCommits((publication) => {
      for (const change of publication.changes)
        if (change.type === "submission") {
          const input = change.value;
          if (
            input.conversationId === conversation.id &&
            input.type === "input" &&
            input.requestId &&
            input.entry !== undefined
          )
            this.inputEntries.set(input.entry, input.requestId);
        }
    });
    const through = stream.snapshot.entries.reduce(
      (latest, entry) => Math.max(latest, entry.id),
      0,
    );
    this.output.restore(
      this.entries.filter((entry) => entry.id <= through),
      stream.snapshot,
      true,
    );
    this.liveActivity.restore(stream.snapshot);
    this.activity(!!stream.snapshot.run, false);
    this.compactions.sync(stream.snapshot.compactions, true);
    this.startEvents(stream);
    logInfo("conversation.observation.started", {
      conversationId: String(conversation.id),
      historyCount: this.entries.length,
      recoveredRunActive: !!stream.snapshot.run,
    });
  }

  private startEvents(stream: AgentEventStream) {
    stream.start((events) => (this.delivery = this.observe(events)));
    void stream.closed.then((end) => {
      if (end.reason === "stopped" || stream !== this.eventStream) return;
      this.observationError =
        end.reason === "listener_error"
          ? end.error
          : end.reason === "session_failed"
            ? new Error("The durable session failed; restart Piko.")
            : new Error(`Durable event stream closed: ${end.reason}`);
      if (!this.isClosed())
        logError("conversation.observation.closed", {
          conversationId: String(this.conversation.id),
          reason: end.reason,
        });
    });
  }

  /** Native app-entry deletion has no SDK publication. Drop the mounted view and rebuild
   * from storage, using the same snapshot recovery as overflow; never stop the conversation. */
  async refreshObservation(): Promise<void> {
    await this.eventStream.stop();
    await this.delivery?.catch(() => {});
    const stream = this.eventStream = await watchEvents(this.harness, this.conversation.id, ctx);
    await this.observe([stream.snapshot]);
    this.startEvents(stream);
  }

  get bindings(): ReadonlyMap<number, string> {
    return this.inputEntries;
  }
  private async observe(events: readonly AgentEvent[]) {
    for (const event of events) {
      if (event.type === "snapshot") {
        this.toolCalls.clear();
        this.entries = await readPiEntries(this.harness, this.conversation.id);
        const through = event.entries.reduce(
          (latest, entry) => Math.max(latest, entry.id),
          0,
        );
        this.output.restore(
          this.entries.filter((entry) => entry.id <= through),
          event,
        );
        this.liveActivity.restore(event);
        this.activity(!!event.run, false);
        this.compactions.sync(event.compactions);
        this.emit({ type: "invalidated" });
      } else {
        if (event.type === "compaction_start") {
          this.compactions.start(event);
          logInfo("conversation.compaction.started", {
            conversationId: String(this.conversation.id),
            reason: event.reason,
          });
        } else if (event.type === "compaction_end") {
          this.compactions.end(event.taskId);
          logInfo("conversation.compaction.finished", {
            conversationId: String(this.conversation.id),
          });
        }
        if (event.type === "tool_execution_start") {
          const summary = summarizeToolArgs(event.toolName, event.args);
          this.toolCalls.set(event.toolCallId, {
            name: event.toolName,
            summary,
            startedAt: Date.now(),
          });
          logInfo("tool.execution.started", {
            conversationId: String(this.conversation.id),
            tool: event.toolName,
          });
          this.emit({
            type: "tool",
            activity: {
              callId: event.toolCallId,
              name: event.toolName,
              summary,
              status: "running",
            },
          });
        } else if (event.type === "tool_execution_end") {
          const call = this.toolCalls.get(event.toolCallId) ?? {
            name: event.toolName,
            summary: "",
            startedAt: Date.now(),
          };
          this.toolCalls.delete(event.toolCallId);
          const result = event.entry?.model?.[0];
          const durationMs =
            result &&
            "durationMs" in result &&
            typeof result.durationMs === "number"
              ? result.durationMs
              : undefined;
          const failed =
            result && "isError" in result && result.isError === true;
          const elapsedMs = durationMs ?? Date.now() - call.startedAt;
          const toolFields = {
            conversationId: String(this.conversation.id),
            tool: call.name,
            durationMs: elapsedMs,
          };
          if (failed) logWarn("tool.execution.failed", toolFields);
          else logInfo("tool.execution.completed", toolFields);
          this.emit({
            type: "tool",
            activity: {
              callId: event.toolCallId,
              name: call.name,
              summary: call.summary,
              status: failed ? "error" : "done",
              ...(durationMs !== undefined && { durationMs }),
            },
          });
        } else if (event.type === "run_end") {
          this.toolCalls.clear();
        }
        if (event.type === "message_end" && event.entry.kind === "pi.user")
          this.emit({ type: "input-applied" });
        if (
          (event.type === "entry_appended" || event.type === "message_end") &&
          event.entry.id > (this.entries.at(-1)?.id ?? 0)
        )
          this.entries.push(event.entry);
        this.output.apply(event);
        this.liveActivity.apply(event);
        if (event.type === "run_start") {
          this.toolCalls.clear();
          this.runStartedAt = Date.now();
          logInfo("conversation.run.started", {
            conversationId: String(this.conversation.id),
          });
          this.activity(true, true);
          this.emit({ type: "run-start" });
        }
        if (event.type === "run_end") {
          this.activity(false, true);
          const submissions = await this.harness.commit(async () => {
            const records = await Promise.all(event.inputs.map(id => this.storage.submission(id, ctx)));
            return records.filter((record): record is SubmissionRecord => !!record).map(submissionReceipt);
          }, ctx);
          const durationMs = this.runStartedAt === undefined
            ? undefined
            : Date.now() - this.runStartedAt;
          this.runStartedAt = undefined;
          logInfo("conversation.run.completed", {
            conversationId: String(this.conversation.id),
            ...(durationMs !== undefined && { durationMs }),
            submissionCount: submissions.length,
            unansweredCount: submissions.filter(
              (item) => item.status === "unanswered",
            ).length,
          });
          this.emit({ type: "run-end", submissions });
        }
        if (
          event.type === "message_end" ||
          event.type === "run_start" ||
          event.type === "run_end" ||
          event.type === "submission"
        )
          this.emit({ type: "invalidated" });
      }
    }
  }
  private emit(event: SessionEvent) {
    if (
      event.type === "message" &&
      !event.final &&
      !this.output.partial(this.entries)
    )
      return;
    if (event.type === "message" && event.previousId) {
      this.previousIds.set(event.message.id, event.previousId);
      if (this.previousIds.size > 128)
        this.previousIds.delete(this.previousIds.keys().next().value!);
    }
    this.publish(event);
  }
  async submission(requestId: string) {
    const record = await this.harness.commit(
      (tx) => tx.submissionByRequest(this.conversation.id, requestId),
      ctx,
    );
    return record && submissionReceipt(record);
  }
  /** Prompt size reported by the last model call, paired with the configured context window. */
  private usage(): ChatUsage | undefined {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.kind !== "pi.assistant") continue;
      const messages = entry.model ?? [];
      for (let part = messages.length - 1; part >= 0; part -= 1) {
        const message = messages[part];
        if (message.role !== "assistant" || !message.usage) continue;
        const value = message.usage;
        const contextWindow =
          this.selected &&
          this.contextWindows.get(
            `${this.selected.provider}/${this.selected.modelId}`,
          );
        return {
          input: value.input,
          output: value.output,
          cacheRead: value.cacheRead,
          cacheWrite: value.cacheWrite,
          totalTokens: value.totalTokens,
          ...(contextWindow && {
            contextWindow,
            ratio:
              (value.input + value.cacheRead + value.cacheWrite) /
              contextWindow,
          }),
        };
      }
    }
    return undefined;
  }
  async history(before?: string, limit?: number) {
    return this.harness.commit(async (tx) => {
      const { entries: _entries, ...page } = await historyPageFromTransaction(
        tx,
        this.inputEntries,
        before,
        limit,
        this.conversation.id,
      );
      return page;
    }, ctx);
  }
  search(query: string, limit: number) {
    return this.harness.commit(
      tx => searchPiHistory(tx, this.inputEntries, query, limit, this.conversation.id),
      ctx,
    );
  }
  historyAround(messageId: string, limit: number) {
    return this.harness.commit(
      tx => historyAroundPiMessage(tx, this.inputEntries, messageId, limit, this.conversation.id),
      ctx,
    );
  }
  async snapshot(options?: { limit: number }) {
    const state = await this.harness.commit(async (tx) => {
      const page =
        options &&
        (await historyPageFromTransaction(
          tx,
          this.inputEntries,
          undefined,
          options.limit,
          this.conversation.id,
        ));
      const entries = page
        ? page.entries
        : await entriesFromTransaction(tx, this.conversation.id);
      const inputs = page
        ? this.inputEntries
        : await inputsFromStorage(this.storage, this.conversation.id);
      const hidden = new Set<number>();
      if (!page)
        for (const [entry, requestId] of inputs)
          if (await internalInput(tx, requestId, this.conversation.id))
            hidden.add(entry);
      const live = await tx.doc(LiveDoc, this.conversation.id);
      let latest: SubmissionRecord | undefined;
      let cursor: Cursor | undefined;
      do {
        const page = await this.storage.scanSubmissions(
          { conversationId: this.conversation.id, order: "descending" },
          100,
          cursor,
          ctx,
        );
        for (const input of page.items)
          if (
            !(await internalInput(tx, input.requestId, this.conversation.id))
          ) {
            latest = input;
            break;
          }
        cursor = page.next;
      } while (!latest && cursor);
      const inbox = await tx.doc(InboxDoc, this.conversation.id);
      const queued: import("../../shared/chat").Message[] = [];
      for (const item of inbox.items)
        if (item.mode !== "write") {
          const input = await this.storage.submission(item.id, ctx);
          if (await internalInput(tx, input?.requestId, this.conversation.id))
            continue;
          queued.push({
            id: `input-${item.id}`,
            role: "user",
            content: messageText(item.content),
            createdAt: 0,
            ...(input?.requestId && { requestId: input.requestId }),
          });
        }
      const recovery = await tx.doc(Recovery, this.conversation.id);
      return {
        entries,
        inputs,
        hidden,
        page,
        running:
          !!live.run || inbox.items.some((item) => item.mode !== "write"),
        activity: this.liveActivity.snapshot(live, !!live.run || inbox.items.some(item => item.mode !== "write")),
        queued,
        latest,
        interruption: recovery.interruption,
        nativeCompactions: (live.compactions ?? []).map((item) => ({
          taskId: item.taskId,
          reason: item.reason,
        })),
      };
    }, ctx);
    this.activity(state.running, false);
    let messages;
    if (state.page) {
      messages = state.page.messages;
      const partial = this.output.partial(state.entries);
      if (partial?.content.trim()) messages = [...messages, partial];
    } else {
      this.entries = state.entries;
      for (const [entry, requestId] of state.inputs)
        this.inputEntries.set(entry, requestId);
      this.hiddenEntries = state.hidden;
      messages = this.messages;
    }
    const usage = this.usage();
    return {
      messages: [...messages, ...state.queued],
      ...(state.page && { history: { nextBefore: state.page.nextBefore } }),
      busy: this.isBusy(),
      activity: this.isBusy() && state.activity.kind === "idle" ? { kind: "thinking" as const } : state.activity,
      compactions: this.compactions.snapshot(state.nativeCompactions),
      previousIds: Object.fromEntries(this.previousIds),
      ...(state.latest && { latest: submissionReceipt(state.latest) }),
      ...(state.interruption && { interruption: state.interruption }),
      ...(usage && { usage }),
    };
  }
  async close(): Promise<void> {
    this.compactions?.close();
    await this.eventStream?.stop();
    await this.delivery?.catch(() => {});
    this.unsubscribeBindings?.();
  }
}
