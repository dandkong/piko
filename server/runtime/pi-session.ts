import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { defineDoc, defineDocFamily, InboxDoc, LiveDoc, watchEvents, type AgentEvent, type AgentEventStream, type Conversation, type EntryRecord, type SubmissionRecord, type TaskId, type Storage, type Cursor, type Harness, configure as configureAgent } from "@earendil-works/pi-durable";
import type { CompactionResult, RuntimeDescription, RuntimeSelection } from "../../shared/runtime";
import type { ChatUsage } from "../../shared/chat";
import type { WorkspacePaths } from "../domain/workspace";
import type { BackgroundReply, InputSource, ChatSession, SessionEvent } from "./types";
import { attachmentPrompt } from "../chat/input";
import { summarizeToolArgs } from "./tool-activity";
import { CompactionExecutionError, RuntimeBusyError } from "./types";
import { CompactionObserver, compactionResult } from "./compactions";
import { entriesFromTransaction, historyPageFromTransaction, inputsFromStorage, messageText, projectPiHistory, readPiEntries, readPiInputs } from "./pi-history";
import { PiMessageEvents } from "./pi-events";
import { internalInput, registerInput } from "./input-origin";
import { loadWorkspaceResources } from "./resources";
import { requireAvailableModel, type WorkspaceModelConfig } from "./model-config";
import type { MemoryCurationService } from "./memory-curation";

export const Recovery = defineDoc<{ interruption: string }>({ kind: "piko.recovery", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ interruption: "" }) });
const StopReceipts = defineDocFamily<{ processed: boolean; stopped: boolean; tasks: number[] }, null>({ kind: "piko.stop", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true, initial: () => ({ processed: false, stopped: false, tasks: [] }) });
function receipt(record: SubmissionRecord): import("../../shared/chat").SubmissionReceipt {
  return { id: String(record.id), ...(record.requestId && { requestId: record.requestId }), status: record.status,
    ...(record.status === "unanswered" && { error: typeof record.detail === "string" ? record.detail : record.reason }) };
}

/** A view/controller for one conversation. Never owns or closes the shared Harness. */
export class DurableChatSession implements ChatSession {
  private memoryCurationService?: MemoryCurationService;
  private compactions!: CompactionObserver;
  private entries: EntryRecord[] = [];
  private inputEntries = new Map<number, string>();
  private unsubscribeBindings?: () => void;
  private eventStream!: AgentEventStream;
  private admission: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private liveBusy = false;
  private observationError?: Error;
  private delivery?: Promise<void>;
  private output = new PiMessageEvents(event => this.emit(event));
  private hiddenEntries = new Set<number>();
  private replyListeners = new Set<(reply: BackgroundReply) => Promise<void>>();
  private pendingReplies: BackgroundReply[] = [];
  private previousIds = new Map<string, string>();
  private readonly contextWindows = new Map<string, number>();
  private selected?: { provider: string; modelId: string };
  private listeners = new Set<(event: SessionEvent) => void>();
  private readonly toolCalls = new Map<string, { name: string; summary: string }>();
  private maintenance?: Promise<unknown>;
  private disposed = false;
  private closing?: Promise<void>;

  constructor(readonly paths: WorkspacePaths, private readonly harness: Harness, private readonly storage: Storage,
    private readonly conversation: Conversation, private readonly config: WorkspaceModelConfig,
    private readonly searchConfigured: boolean, private readonly assertWritable: () => Promise<void> = async () => {}) {}

  get isStreaming() { return !!this.maintenance || this.stopping || this.liveBusy; }
  get closePromise() { return this.closing; }
  get messages() {
    const messages = projectPiHistory(this.entries, this.inputEntries, this.hiddenEntries).messages;
    const partial = this.output.partial(this.entries);
    return partial?.content.trim() ? [...messages, partial] : messages;
  }
  get native() { return this.conversation; }
  get nativeHarness() { return this.harness; }

  async init(): Promise<void> {
    const { harness, storage, conversation } = this;
    this.compactions = new CompactionObserver(harness, event => this.emit(event), () => this.emit({ type: "refresh" }));
    const agent = await conversation.agent(ctx);
    this.selected = agent.model && { provider: agent.model.provider, modelId: agent.model.modelId };
    for (const model of await this.config.models.getAvailable()) this.contextWindows.set(`${model.provider}/${model.id}`, model.contextWindow);
    const stream = this.eventStream = await watchEvents(harness, conversation.id, ctx);
    this.entries = await readPiEntries(harness, conversation.id);
    this.inputEntries = await readPiInputs(harness, storage, conversation.id);
    this.hiddenEntries = await harness.commit(async tx => {
      const hidden = new Set<number>();
      for (const [entry, requestId] of this.inputEntries) if (await internalInput(tx, requestId, conversation.id)) hidden.add(entry);
      return hidden;
    }, ctx);
    this.unsubscribeBindings = harness.subscribeCommits(publication => {
      for (const change of publication.changes) if (change.type === "submission") {
        const input = change.value;
        if (input.conversationId === conversation.id && input.type === "input" && input.requestId && input.entry !== undefined) this.inputEntries.set(input.entry, input.requestId);
      }
    });
    const through = stream.snapshot.entries.reduce((latest, entry) => Math.max(latest, entry.id), 0);
    this.output.restore(this.entries.filter(entry => entry.id <= through), stream.snapshot, true);
    this.liveBusy = !!stream.snapshot.run;
    this.compactions.sync(stream.snapshot.compactions, true);
    stream.start(events => this.delivery = this.observe(events));
    void stream.closed.then(end => {
      this.observationError = end.reason === "listener_error" ? end.error
        : end.reason === "session_failed" ? new Error("The durable session failed; restart Piko.") : new Error(`Durable event stream closed: ${end.reason}`);
      if (!this.disposed) console.error("Piko conversation event stream closed:", conversation.id, end);
    });
  }

  get bindings(): ReadonlyMap<number, string> { return this.inputEntries; }
  get canReport() { return !this.maintenance && !this.stopping && !this.disposed; }
  attachMemory(service: MemoryCurationService) { this.memoryCurationService = service; }
  async backgroundReply(reply: BackgroundReply) {
    if (!this.replyListeners.size) {
      if (reply.deliver === "all" || reply.source.channel === "telegram") this.pendingReplies.push(reply);
      return;
    }
    await Promise.allSettled([...this.replyListeners].map(listener => listener(reply)));
  }
  async ensureReady() { await this.requireCurrentAgent(); }
  async archive(operation: () => Promise<void>) {
    return this.serial(async () => {
      if (this.disposed || this.maintenance) throw new RuntimeBusyError();
      await this.abortCurrent();
      await operation();
    });
  }

  private async observe(events: readonly AgentEvent[]) {
    for (const event of events) {
      if (event.type === "snapshot") {
        this.entries = await readPiEntries(this.harness, this.conversation.id);
        const through = event.entries.reduce((latest, entry) => Math.max(latest, entry.id), 0);
        this.output.restore(this.entries.filter(entry => entry.id <= through), event);
        this.liveBusy = !!event.run;
        this.compactions.sync(event.compactions);
        this.emit({ type: "refresh" });
      } else {
        if (event.type === "compaction_start") this.compactions.start(event);
        else if (event.type === "compaction_end") this.compactions.end(event.taskId);
        if (event.type === "tool_execution_start") {
          const summary = summarizeToolArgs(event.toolName, event.args);
          this.toolCalls.set(event.toolCallId, { name: event.toolName, summary });
          this.emit({ type: "tool", activity: { callId: event.toolCallId, name: event.toolName, summary, status: "running" } });
        } else if (event.type === "tool_execution_end") {
          const call = this.toolCalls.get(event.toolCallId) ?? { name: event.toolName, summary: "" };
          this.toolCalls.delete(event.toolCallId);
          const result = event.entry?.model?.[0];
          const durationMs = result && "durationMs" in result && typeof result.durationMs === "number" ? result.durationMs : undefined;
          const failed = result && "isError" in result && result.isError === true;
          this.emit({ type: "tool", activity: { callId: event.toolCallId, name: call.name, summary: call.summary,
            status: failed ? "error" : "done", ...(durationMs !== undefined && { durationMs }) } });
        } else if (event.type === "run_end") {
          this.toolCalls.clear();
          this.emit({ type: "tool-clear" });
        }
        if ((event.type === "entry_appended" || event.type === "message_end") && event.entry.id > (this.entries.at(-1)?.id ?? 0)) this.entries.push(event.entry);
        this.output.apply(event);
        if (event.type === "run_start") {
          this.liveBusy = true;
          void this.memoryCurationService?.onRunStart().catch(error => console.warn("Piko memory review activity:", error instanceof Error ? error.message : "failed"));
        }
        if (event.type === "run_end") {
          this.liveBusy = false;
          void this.memoryCurationService?.onRunEnd().catch(error => console.warn("Piko memory review activity:", error instanceof Error ? error.message : "failed"));
        }
        if (event.type === "message_end" || event.type === "run_start" || event.type === "run_end" || event.type === "submission") this.emit({ type: "refresh" });
      }
    }
  }
  private emit(event: SessionEvent) {
    if (event.type === "message" && !event.final && !this.output.partial(this.entries)) return;
    if (event.type === "message" && event.previousId) { this.previousIds.set(event.message.id, event.previousId); if (this.previousIds.size > 128) this.previousIds.delete(this.previousIds.keys().next().value!); }
    for (const listener of this.listeners) { try { listener(event); } catch (error) { console.error("Piko output observer:", error); } }
  }
  subscribe(listener: (event: SessionEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  subscribeBackgroundReplies(listener: (reply: BackgroundReply) => Promise<void>) {
    this.replyListeners.add(listener);
    for (const reply of this.pendingReplies.splice(0)) void listener(reply).catch(error => console.warn("Piko background delivery attachment failed.", error instanceof Error ? error.name : "unknown"));
    return () => { this.replyListeners.delete(listener); };
  }
  async submission(requestId: string) {
    const record = await this.harness.commit(tx => tx.submissionByRequest(this.conversation.id, requestId), ctx);
    return record && receipt(record);
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
        const contextWindow = this.selected && this.contextWindows.get(`${this.selected.provider}/${this.selected.modelId}`);
        return { input: value.input, output: value.output, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite,
          totalTokens: value.totalTokens,
          ...(contextWindow && { contextWindow, ratio: (value.input + value.cacheRead + value.cacheWrite) / contextWindow }) };
      }
    }
    return undefined;
  }
  async history(before?: string, limit?: number) {
    return this.harness.commit(async tx => {
      const { entries: _entries, ...page } = await historyPageFromTransaction(tx, this.inputEntries, before, limit, this.conversation.id);
      return page;
    }, ctx);
  }
  async snapshot(options?: { limit: number }) {
    const state = await this.harness.commit(async tx => {
      const page = options && await historyPageFromTransaction(tx, this.inputEntries, undefined, options.limit, this.conversation.id);
      const entries = page ? page.entries : await entriesFromTransaction(tx, this.conversation.id);
      const inputs = page ? this.inputEntries : await inputsFromStorage(this.storage, this.conversation.id);
      const hidden = new Set<number>();
      if (!page) for (const [entry, requestId] of inputs) if (await internalInput(tx, requestId, this.conversation.id)) hidden.add(entry);
      const live = await tx.doc(LiveDoc, this.conversation.id);
      let latest: SubmissionRecord | undefined;
      let cursor: Cursor | undefined;
      do {
        const page = await this.storage.scanSubmissions({ conversationId: this.conversation.id, order: "descending" }, 100, cursor, ctx);
        for (const input of page.items) if (!await internalInput(tx, input.requestId, this.conversation.id)) { latest = input; break; }
        cursor = page.next;
      } while (!latest && cursor);
      const inbox = await tx.doc(InboxDoc, this.conversation.id);
      const queued: import("../../shared/chat").Message[] = [];
      for (const item of inbox.items) if (item.mode !== "write") {
        const input = await this.storage.submission(item.id, ctx);
        if (await internalInput(tx, input?.requestId, this.conversation.id)) continue;
        queued.push({ id: `input-${item.id}`, role: "user", content: messageText(item.content), createdAt: 0, ...(input?.requestId && { requestId: input.requestId }) });
      }
      const recovery = await tx.doc(Recovery, this.conversation.id);
      return { entries, inputs, hidden, page, running: !!live.run || inbox.items.some(item => item.mode !== "write"), queued, latest, interruption: recovery.interruption, nativeCompactions: (live.compactions ?? []).map(item => ({ taskId: item.taskId, reason: item.reason })) };
    }, ctx);
    this.liveBusy = state.running;
    let messages;
    if (state.page) {
      messages = state.page.messages;
      const partial = this.output.partial(state.entries);
      if (partial?.content.trim()) messages = [...messages, partial];
    } else {
      this.entries = state.entries;
      for (const [entry, requestId] of state.inputs) this.inputEntries.set(entry, requestId);
      this.hiddenEntries = state.hidden;
      messages = this.messages;
    }
    const usage = this.usage();
    return { messages: [...messages, ...state.queued], ...(state.page && { history: { nextBefore: state.page.nextBefore } }), busy: this.isStreaming, compactions: this.compactions.snapshot(state.nativeCompactions), previousIds: Object.fromEntries(this.previousIds),
      ...(state.latest && { latest: receipt(state.latest) }), ...(state.interruption && { interruption: state.interruption }), ...(usage && { usage }) };
  }
  async submit(text: string, requestId: string, source: InputSource = { channel: "app" }, attachments: readonly string[] = []) {
    if (requestId.startsWith("piko:")) throw new Error("Reserved input identity.");
    const prompt = attachmentPrompt(text, attachments);
    return this.serial(async () => {
      if (this.disposed) throw new Error("Piko is shutting down.");
      if (this.maintenance || this.stopping) throw new RuntimeBusyError();
      if (this.observationError) throw this.observationError;
      const existing = await this.submission(requestId);
      if (existing) return { submission: existing, duplicate: true };
      await this.assertWritable();
      await this.requireCurrentAgent();
      await this.conversation.commit(async tx => { (await tx.doc(Recovery, this.conversation.id)).interruption = ""; await registerInput(tx, requestId, source, false, undefined, this.conversation.id); }, ctx);
      const handle = await this.conversation.submit({ type: "input", content: prompt, requestId, whenBusy: "steer" }, ctx);
      this.liveBusy = true;
      void handle.wait(ctx).then(async settled => {
        if (settled.status === "unanswered" && settled.reason !== "aborted" && settled.reason !== "withdrawn_after_failure") {
          const cleanup = this.serial(async () => {
            await this.conversation.commit(async tx => {
              const inbox = await tx.doc(InboxDoc, this.conversation.id);
              for (const item of inbox.items) if (item.mode !== "write") tx.settleSubmission(item.id,
                { status: "unanswered", reason: "withdrawn_after_failure", detail: typeof settled.detail === "string" ? settled.detail : settled.reason });
              inbox.items = inbox.items.filter(item => item.mode === "write");
            }, ctx);
            await this.abortCurrent();
          });
          this.emit({ type: "error", message: typeof settled.detail === "string" ? settled.detail : settled.reason });
          await cleanup;
        }
        this.emit({ type: "refresh" });
      }).catch(error => { if (!this.disposed) this.emit({ type: "error", message: error instanceof Error ? error.message : "Reply failed." }); });
      return { submission: receipt(await handle.status(ctx)), duplicate: false };
    });
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.admission.catch(() => {}).then(operation); this.admission = task; return task;
  }
  abort(commandId?: string): Promise<boolean> { return this.serial(() => this.abortCurrent(commandId)); }
  private async abortCurrent(commandId?: string): Promise<boolean> {
    const wasActive = this.isStreaming;
    this.stopping = true; this.emit({ type: "refresh" });
    try {
      if (!commandId) { await this.conversation.abort(ctx); this.liveBusy = false; return wasActive; }
      // Capture original task IDs and withdraw original queued inputs atomically with the receipt.
      const target = await this.conversation.commit(async tx => {
        const saved = await tx.doc(StopReceipts, this.conversation.id, commandId, null);
        if (saved.processed) return { stopped: saved.stopped, tasks: [...saved.tasks] };
        let cursor: Cursor | undefined; const tasks: number[] = [];
        do {
          const page = await tx.scanTasks({ conversationId: this.conversation.id }, 500, cursor);
          for (const task of page.items) if (task.state.status !== "terminal" && !task.background) tasks.push(task.id);
          cursor = page.next;
        } while (cursor);
        const inbox = await tx.doc(InboxDoc, this.conversation.id);
        const stopped = tasks.length > 0 || inbox.items.some(item => item.mode !== "write");
        for (const item of inbox.items) if (item.mode !== "write") tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
        inbox.items = inbox.items.filter(item => item.mode === "write");
        saved.processed = true; saved.stopped = stopped; saved.tasks = tasks;
        return { stopped, tasks };
      }, ctx);
      for (const id of target.tasks) await this.harness.abortTask(id as TaskId, ctx);
      return target.stopped;

    } finally { this.stopping = false; this.emit({ type: "refresh" }); }
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    this.compactions?.close();
    this.closing = (async () => {
      await this.admission.catch(() => {});
      await this.conversation.abort(ctx);
      await this.maintenance?.catch(() => {});
      await this.eventStream?.stop();
      await this.delivery?.catch(() => {});
      this.unsubscribeBindings?.();
      this.listeners.clear(); this.replyListeners.clear(); this.pendingReplies = [];
    })();
    return this.closing;
  }
  /** Reserve maintenance on the same input line; do not hold it while work runs, so stop remains available. */
  private async maintain<T>(operation: () => Promise<T>): Promise<T> {
    const reserved = await this.serial(async () => {
      if (this.disposed || this.isStreaming) throw new RuntimeBusyError();
      if (this.observationError) throw this.observationError;
      await this.assertWritable();
      const task = Promise.resolve().then(operation); this.maintenance = task; this.emit({ type: "refresh" });
      return { task };
    });
    try { return await reserved.task; }
    finally { this.maintenance = undefined; this.emit({ type: "refresh" }); }
  }
  async configure(selection: RuntimeSelection) { return this.maintain(async () => {
    const agent = await this.conversation.agent(ctx);
    const profile = "provider" in selection ? selection
      : agent.model && { provider: agent.model.provider, model: agent.model.modelId, thinking: selection.thinking };
    if (!profile) throw new Error("No current model to change the thinking level.");
    const model = await requireAvailableModel(this.config.models, profile);
    const thinking = profile.thinking ?? ("provider" in selection ? clampThinkingLevel(model, agent.thinkingLevel) : "off");
    if (!getSupportedThinkingLevels(model).includes(thinking)) throw new Error("This model does not support that thinking level.");
    await this.harness.commit(async tx => {
      await configureAgent(tx, this.conversation.id, { model: { provider: model.provider, modelId: model.id }, thinkingLevel: thinking });
    }, ctx);
    this.selected = { provider: model.provider, modelId: model.id };
  }); }
  async describe(): Promise<RuntimeDescription> {
    const agent = await this.conversation.agent(ctx);
    const resources = await loadWorkspaceResources(this.paths);
    const tools = agent.tools.map(tool => ({ name: tool.name,
      status: tool.name === "web_search" && !this.searchConfigured ? "unconfigured" as const : "available" as const }));
    return { runtime: "pi-durable", tools, ...(agent.model && { selection: { provider: agent.model.provider, model: agent.model.modelId, thinking: agent.thinkingLevel } }),
      models: (await this.config.models.getAvailable()).map(model => ({ provider: model.provider, id: model.id, name: model.name,
        imageInput: model.input.includes("image"), contextWindow: model.contextWindow, thinkingLevels: getSupportedThinkingLevels(model) as ModelThinkingLevel[] })),
      skills: resources.skills };
  }
  async modelReady() { return (await this.config.models.getAvailable()).length > 0; }

  /** One gate for input, saved tasks and maintenance: a stored model with usable credentials. */
  private async requireCurrentAgent() {
    const agent = await this.conversation.agent(ctx);
    if (!agent.model) throw new Error("No model is configured. Add its credentials, then choose a model in PIKO_HOME/config/piko.json under agent.profiles.");
    await requireAvailableModel(this.config.models, { provider: agent.model.provider, model: agent.model.modelId });
    return agent;
  }

  async compact(): Promise<CompactionResult> {
    return this.maintain<CompactionResult>(async () => {
      const task = await this.conversation.compact(undefined, ctx);
      try { return await compactionResult(this.harness, task); }
      catch (error) { throw new CompactionExecutionError(error instanceof Error ? error.message : "Compaction failed."); }
    });
  }
}
