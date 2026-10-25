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
    { name: string; summary: string }
  >();
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
      () => this.emit({ type: "refresh" }),
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
    this.activity(!!stream.snapshot.run, false);
    this.compactions.sync(stream.snapshot.compactions, true);
    stream.start((events) => (this.delivery = this.observe(events)));
    void stream.closed.then((end) => {
      this.observationError =
        end.reason === "listener_error"
          ? end.error
          : end.reason === "session_failed"
            ? new Error("The durable session failed; restart Piko.")
            : new Error(`Durable event stream closed: ${end.reason}`);
      if (!this.isClosed())
        console.error(
          "Piko conversation event stream closed:",
          conversation.id,
          end,
        );
    });
  }

  get bindings(): ReadonlyMap<number, string> {
    return this.inputEntries;
  }
  private async observe(events: readonly AgentEvent[]) {
    for (const event of events) {
      if (event.type === "snapshot") {
        this.entries = await readPiEntries(this.harness, this.conversation.id);
        const through = event.entries.reduce(
          (latest, entry) => Math.max(latest, entry.id),
          0,
        );
        this.output.restore(
          this.entries.filter((entry) => entry.id <= through),
          event,
        );
        this.activity(!!event.run, false);
        this.compactions.sync(event.compactions);
        this.emit({ type: "refresh" });
      } else {
        if (event.type === "compaction_start") this.compactions.start(event);
        else if (event.type === "compaction_end")
          this.compactions.end(event.taskId);
        if (event.type === "tool_execution_start") {
          const summary = summarizeToolArgs(event.toolName, event.args);
          this.toolCalls.set(event.toolCallId, {
            name: event.toolName,
            summary,
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
          this.emit({ type: "tool-clear" });
        }
        if (
          (event.type === "entry_appended" || event.type === "message_end") &&
          event.entry.id > (this.entries.at(-1)?.id ?? 0)
        )
          this.entries.push(event.entry);
        this.output.apply(event);
        if (event.type === "run_start") {
          this.activity(true, true);
        }
        if (event.type === "run_end") {
          this.activity(false, true);
        }
        if (
          event.type === "message_end" ||
          event.type === "run_start" ||
          event.type === "run_end" ||
          event.type === "submission"
        )
          this.emit({ type: "refresh" });
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
