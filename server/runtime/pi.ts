import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { clampThinkingLevel, getSupportedThinkingLevels, type Models, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineDocFamily, InboxDoc, LiveDoc, Harness, ROOT_CONVERSATION_ID, watchEvents, type AgentEvent, type AgentEventStream, type Conversation, type EntryRecord, type SubmissionRecord, type TaskId, type Storage, type Cursor, type Registry, configure as configureAgent } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { CompactionResult, RuntimeDescription, RuntimeSelection } from "../../shared/runtime";
import type { ChatUsage } from "../../shared/chat";
import type { WorkspacePaths } from "../domain/workspace";
import type { BackgroundReply, InputSource, ChatRuntime, ChatSession, SessionEvent } from "./types";
import { RuntimeBusyError } from "./types";
import { sessionDirectory } from "./pi-context";
import { entriesFromTransaction, historyPageFromTransaction, inputsFromStorage, messageText, projectPiHistory, readPiEntries, readPiInputs } from "./pi-history";
import { PiMessageEvents } from "./pi-events";
import { createSubagents, prepareRestart, subagentIds } from "./subagents";
import { childScope } from "./background";
import { createWorkItemTools, DurableWorkItems } from "./work-items";
import { ItemContext } from "./item-context";
import { ItemFiles } from "../domain/work-items";
import { internalInput, registerInput } from "./input-origin";
import { createWorkspaceResources, loadWorkspaceResources } from "./resources";
import { runtimePaths } from "./config/paths";
import { loadWorkspaceModels, requireAvailableModel, availableBackground, configuredBackground, type WorkspaceModelConfig } from "./model-config";
import { readConfigEnvironment } from "../config/files";
import { readApplicationSettings, type ApplicationSettings } from "../config";
import { createWebTools } from "./web-tools";
import { WorkspaceExecutionEnv } from "./execution-env";
import { createMemoryCurationExtension, MemoryCurationService } from "./memory-curation";

export const PIKO_TOOL_NAMES = ["read", "write", "edit", "bash"];
const Recovery = defineDoc<{ interruption: string }>({ kind: "piko.recovery", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ interruption: "" }) });
const StopReceipts = defineDocFamily<{ processed: boolean; stopped: boolean; tasks: number[] }, null>({ kind: "piko.stop", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true, initial: () => ({ processed: false, stopped: false, tasks: [] }) });
function receipt(record: SubmissionRecord): import("../../shared/chat").SubmissionReceipt {
  return { id: String(record.id), ...(record.requestId && { requestId: record.requestId }), status: record.status,
    ...(record.status === "unanswered" && { error: typeof record.detail === "string" ? record.detail : record.reason }) };
}

type SessionRegistry = { registry: Registry; searchConfigured: boolean };
function registry(paths: WorkspacePaths, settings: ApplicationSettings, env: Record<string, string | undefined>,
  subagents: import("@earendil-works/pi-durable").Extension, items: import("@earendil-works/pi-durable").Extension,
  memory: import("@earendil-works/pi-durable").Extension): SessionRegistry {
  const value = createRegistry();
  const web = createWebTools(env, { settings: settings.tools });
  value.install(CodingTools);
  value.install(createWorkspaceResources(paths));
  value.install(web.extension);
  value.install(subagents);
  value.install(items);
  value.install(memory);
  return { registry: value, searchConfigured: web.searchConfigured };
}

/** One native Harness and root conversation per PIKO_HOME. UI reads raw entries; provider context stays durable's responsibility. */
export class DurableChatSession implements ChatSession {
  private harness!: Harness;
  private storage!: Storage;
  private conversation!: Conversation;
  private config!: WorkspaceModelConfig;
  private extensions!: SessionRegistry;
  private itemService!: DurableWorkItems;
  private memoryCurationService?: MemoryCurationService;
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
  private maintenance?: Promise<unknown>;
  private disposed = false;
  private closing?: Promise<void>;

  constructor(readonly paths: WorkspacePaths, private readonly injected?: Models) {}

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
    // Application JSON and the private env file are read once per boot, then passed down.
    const settings = readApplicationSettings(this.paths.home);
    const env = readConfigEnvironment(this.paths.home);
    const config = await loadWorkspaceModels({ home: this.paths.home, settings, env, models: this.injected });
    const children = createSubagents({ storage: () => this.storage,
      canReport: () => !this.maintenance && !this.stopping && !this.disposed,
      background: () => this.background(),
      onReply: async reply => {
        // Queue what a channel still needs to see: scheduled broadcasts and Telegram-origin reports.
        if (!this.replyListeners.size) { if (reply.deliver === "all" || reply.source.channel === "telegram") this.pendingReplies.push(reply); return; }
        await Promise.allSettled([...this.replyListeners].map(listener => listener(reply)));
      },
    });
    const memory = createMemoryCurationExtension({ workspace: this.paths.workspace, bindings: () => this.inputEntries,
      background: () => this.background() });
    const extensions = registry(this.paths, settings, env, children.extension, createWorkItemTools(() => this.itemService), memory.extension);
    await this.open(config, extensions, children, memory.task);
  }

  workItems() { return this.itemService; }

  private async open(config: WorkspaceModelConfig, extensions: SessionRegistry, children: ReturnType<typeof createSubagents>,
    memoryTask: ReturnType<typeof createMemoryCurationExtension>["task"]): Promise<void> {
    const directory = sessionDirectory(runtimePaths(this.paths.home).sessions);
    const persisted = existsSync(join(directory, "main.jsonl"));
    const storage = await openNodeJsonlStorage(directory, ctx, { fsync: true });
    let harness: Harness;
    try {
      harness = await Harness.open(storage, { models: config.models, registry: extensions.registry,
        env: ({ cwd }) => new WorkspaceExecutionEnv(cwd ?? this.paths.workspace, runtimePaths(this.paths.home).tmp),
        // Retry and compaction are deliberately left to Durable's built-in defaults.
        settings: { ...config.harnessSettings, toolExecution: "sequential", steeringMode: "all" },
        onReport: error => console.error("Piko durable:", error),
      }, ctx);
    } catch (error) { await storage.close(ctx); throw error; }
    try {
      const existing = await harness.conversation(ROOT_CONVERSATION_ID, ctx);
      if (persisted && !existing) throw new Error("Durable root conversation is missing.");
      const preferred = config.main;
      const selected = preferred ? await requireAvailableModel(config.models, preferred) : (await config.models.getAvailable())[0];
      const conversation = existing ?? await harness.root(ctx, { agent: {
        cwd: this.paths.workspace,
        ...(selected && { model: { provider: selected.provider, modelId: selected.id } }),
        thinkingLevel: preferred?.thinking ?? "off",
      } });
      if (existing && resolve((await conversation.agent(ctx)).cwd ?? this.paths.workspace) !== resolve(this.paths.workspace)) throw new Error("The configured workspace differs from the saved conversation. Restore its original path or use a new PIKO_HOME.");
      const live = await harness.snapshot(LiveDoc, conversation.id, ctx);
      const inbox = await harness.snapshot(InboxDoc, conversation.id, ctx);
      const interrupted = !!live?.run || !!inbox?.items.some(item => item.mode !== "write");
      // Startup policy is applied before submit/wait enables the scheduler.
      const recovery = await prepareRestart(harness);
      if (interrupted || recovery.interrupted) await conversation.commit(async tx => {
        (await tx.doc(Recovery, conversation.id)).interruption = "The previous work was interrupted by a server restart. Please resend if needed.";
        await tx.appendEntry(conversation.id, { kind: "piko.interrupted", model: [{ role: "user", content: "The previous work was interrupted. Saved messages are historical context. Do not resume or repeat its tools automatically; act only on new user requests or newly delivered background results; do not resume interrupted work.", timestamp: Date.now() }] });
      }, ctx);
      if (existing && selected && !(await conversation.agent(ctx)).model) await conversation.configure({ model: { provider: selected.provider, modelId: selected.id }, thinkingLevel: preferred?.thinking ?? "off" }, ctx);
      // Built-in registry configuration is rebuilt at startup; children start from the configured background profile.
      const rootAgent = await conversation.agent(ctx);
      const background = configuredBackground(config.background);
      await harness.commit(async tx => {
        const ids = await subagentIds(tx);
        const scope = childScope(rootAgent);
        for (const id of ids) {
          const binding = (await tx.doc(ItemContext, id)).binding;
          await configureAgent(tx, id, { ...(background
            ? { model: { provider: background.provider, modelId: background.modelId }, thinkingLevel: background.thinkingLevel }
            : { model: rootAgent.model, thinkingLevel: rootAgent.thinkingLevel }),
            cwd: binding ? new ItemFiles(this.paths.workspace).directory(binding.itemId) : rootAgent.cwd,
            extensions: scope.extensions, tools: scope.tools });
        }
      }, ctx);
      this.storage = storage; this.harness = harness; this.conversation = conversation; this.config = config; this.extensions = extensions;
      this.selected = selected && { provider: selected.provider, modelId: selected.id };
      for (const model of await config.models.getAvailable()) this.contextWindows.set(`${model.provider}/${model.id}`, model.contextWindow);
      this.itemService = new DurableWorkItems(harness, this.paths.workspace, children, async () => {
        if (this.disposed) throw new Error("Piko is shutting down.");
        if (this.maintenance || this.stopping) throw new RuntimeBusyError();
        await this.requireCurrentAgent();
      });
      this.memoryCurationService = new MemoryCurationService(harness, memoryTask, () => this.inputEntries);
      const stream = this.eventStream = await watchEvents(harness, conversation.id, ctx);
      this.entries = await readPiEntries(harness);
      this.inputEntries = await readPiInputs(harness, storage);
      this.hiddenEntries = await harness.commit(async tx => {
        const hidden = new Set<number>();
        for (const [entry, requestId] of this.inputEntries) if (await internalInput(tx, requestId)) hidden.add(entry);
        return hidden;
      }, ctx);
      // Publication is synchronous on the native commit line: newly placed inputs
      // are bound before a paginated snapshot reads entries from that same line.
      this.unsubscribeBindings = harness.subscribeCommits(publication => {
        for (const change of publication.changes) if (change.type === "submission") {
          const input = change.value;
          if (input.conversationId === conversation.id && input.type === "input" && input.requestId && input.entry !== undefined) this.inputEntries.set(input.entry, input.requestId);
        }
      });
      const through = stream.snapshot.entries.reduce((latest, entry) => Math.max(latest, entry.id), 0);
      this.output.restore(this.entries.filter(entry => entry.id <= through), stream.snapshot, true);
      stream.start(events => this.delivery = this.observe(events));
      harness.resume();
      this.itemService.start();
      await this.memoryCurationService.start();
      void stream.closed.then(end => {
        this.observationError = end.reason === "listener_error" ? end.error : new Error(`Durable event stream closed: ${end.reason}`);
        if (!this.disposed) console.error("Piko durable event stream closed:", end);
      });
    } catch (error) { this.unsubscribeBindings?.(); await harness.close(ctx); throw error; }
  }

  private async observe(events: readonly AgentEvent[]) {
    for (const event of events) {
      if (event.type === "snapshot") {
        this.entries = await readPiEntries(this.harness);
        const through = event.entries.reduce((latest, entry) => Math.max(latest, entry.id), 0);
        this.output.restore(this.entries.filter(entry => entry.id <= through), event);
        this.liveBusy = !!event.run;
        this.emit({ type: "refresh" });
      } else {
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
      const { entries: _entries, ...page } = await historyPageFromTransaction(tx, this.inputEntries, before, limit);
      return page;
    }, ctx);
  }
  async snapshot(options?: { limit: number }) {
    const state = await this.harness.commit(async tx => {
      const page = options && await historyPageFromTransaction(tx, this.inputEntries, undefined, options.limit);
      const entries = page ? page.entries : await entriesFromTransaction(tx);
      const inputs = page ? this.inputEntries : await inputsFromStorage(this.storage);
      const hidden = new Set<number>();
      if (!page) for (const [entry, requestId] of inputs) if (await internalInput(tx, requestId)) hidden.add(entry);
      const live = await tx.doc(LiveDoc, this.conversation.id);
      let latest: SubmissionRecord | undefined;
      let cursor: Cursor | undefined;
      do {
        const page = await this.storage.scanSubmissions({ conversationId: this.conversation.id, order: "descending" }, 100, cursor, ctx);
        for (const input of page.items) if (!await internalInput(tx, input.requestId)) { latest = input; break; }
        cursor = page.next;
      } while (!latest && cursor);
      const inbox = await tx.doc(InboxDoc, this.conversation.id);
      const queued: import("../../shared/chat").Message[] = [];
      for (const item of inbox.items) if (item.mode !== "write") {
        const input = await this.storage.submission(item.id, ctx);
        if (await internalInput(tx, input?.requestId)) continue;
        queued.push({ id: `input-${item.id}`, role: "user", content: messageText(item.content), createdAt: 0, ...(input?.requestId && { requestId: input.requestId }) });
      }
      const recovery = await tx.doc(Recovery, this.conversation.id);
      return { entries, inputs, hidden, page, running: !!live.run || inbox.items.some(item => item.mode !== "write"), queued, latest, interruption: recovery.interruption };
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
    return { messages: [...messages, ...state.queued], ...(state.page && { history: { nextBefore: state.page.nextBefore } }), busy: this.isStreaming, previousIds: Object.fromEntries(this.previousIds),
      ...(state.latest && { latest: receipt(state.latest) }), ...(state.interruption && { interruption: state.interruption }), ...(usage && { usage }) };
  }
  async submit(text: string, requestId: string, source: InputSource = { channel: "app" }) {
    if (requestId.startsWith("piko:")) throw new Error("Reserved input identity.");
    return this.serial(async () => {
      if (this.disposed) throw new Error("Piko is shutting down.");
      if (this.maintenance || this.stopping) throw new RuntimeBusyError();
      if (this.observationError) throw this.observationError;
      const existing = await this.submission(requestId);
      if (existing) return { submission: existing, duplicate: true };
      await this.requireCurrentAgent();
      await this.conversation.commit(async tx => { (await tx.doc(Recovery, this.conversation.id)).interruption = ""; await registerInput(tx, requestId, source); }, ctx);
      const handle = await this.conversation.submit({ type: "input", content: text, requestId, whenBusy: "steer" }, ctx);
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
  private async closeNative() {
    this.memoryCurationService?.close();
    await this.eventStream.stop();
    // Listener errors are already reported by stream.closed; release the native runtime.
    await this.delivery?.catch(() => {});
    this.unsubscribeBindings?.();
    await this.harness.close(ctx);
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    this.closing = (async () => {
      await this.itemService.close();
      this.memoryCurationService?.close();
      await this.admission.catch(() => {});
      const maintenance = this.maintenance;
      if (maintenance) {
        await this.conversation.abort(ctx);
        await maintenance.catch(() => {});
      }
      await this.closeNative(); this.listeners.clear(); this.replyListeners.clear(); this.pendingReplies = [];
    })();
    return this.closing;
  }
  /** Reserve maintenance on the same input line; do not hold it while work runs, so stop remains available. */
  private async maintain<T>(operation: () => Promise<T>): Promise<T> {
    const reserved = await this.serial(async () => {
      if (this.disposed || this.isStreaming) throw new RuntimeBusyError();
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
      status: tool.name === "web_search" && !this.extensions.searchConfigured ? "unconfigured" as const : "available" as const }));
    return { runtime: "pi-durable", tools, ...(agent.model && { selection: { provider: agent.model.provider, model: agent.model.modelId, thinking: agent.thinkingLevel } }),
      models: (await this.config.models.getAvailable()).map(model => ({ provider: model.provider, id: model.id, name: model.name,
        imageInput: model.input.includes("image"), contextWindow: model.contextWindow, thinkingLevels: getSupportedThinkingLevels(model) as ModelThinkingLevel[] })),
      skills: resources.skills };
  }
  async modelReady() { return (await this.config.models.getAvailable()).length > 0; }

  /** One gate for input, work items and maintenance: a stored model with usable credentials. */
  private async requireCurrentAgent() {
    const agent = await this.conversation.agent(ctx);
    if (!agent.model) throw new Error("No model is configured. Add its credentials, then choose a model in PIKO_HOME/config/piko.json under agent.profiles.");
    await requireAvailableModel(this.config.models, { provider: agent.model.provider, model: agent.model.modelId });
    return agent;
  }

  /** Background jobs read agent.profiles.background at spawn; credentials are checked then, not at startup. */
  private background() {
    return this.config ? availableBackground(this.config.models, this.config.background) : Promise.resolve(undefined);
  }
  async compact(): Promise<CompactionResult> {
    return this.maintain<CompactionResult>(async () => {
      const task = await this.conversation.compact(undefined, ctx);
      const settled = await this.harness.waitForTask(task, ctx);
      const outcome = settled.state.outcome;
      if (outcome.status === "aborted") return { status: "cancelled" };
      if (outcome.status === "failed" || outcome.status === "faulted") throw new Error(outcome.error.message);
      if (outcome.status !== "completed") throw new Error("Compaction did not complete.");
      if (outcome.result.entryId !== undefined) return { status: "compacted" };
      if (outcome.result.submissionId === undefined) return { status: "skipped", reason: "no_summary" };
      const submission = await this.harness.submission(outcome.result.submissionId, ctx);
      if (!submission) throw new Error("Compaction result is unavailable.");
      const placed = await submission.wait(ctx);
      if (placed.status === "done") return { status: "compacted" };
      if (placed.reason === "aborted") return { status: "cancelled" };
      if (placed.reason === "stale") return { status: "skipped", reason: "stale" };
      throw new Error(`Compaction could not be applied: ${placed.reason}`);
    });
  }
}

/** One native Harness owns the workspace. Opening is serialized; model work runs independently. */
export function createPiRuntime(paths: WorkspacePaths, options: { models?: Models } = {}): ChatRuntime {
  let session: DurableChatSession | undefined; let opening: Promise<DurableChatSession> | undefined;
  async function get() {
    if (session && !session.closePromise) return session;
    if (session?.closePromise) await session.closePromise;
    if (!opening) opening = (async () => {
      const value = new DurableChatSession(paths, options.models); await value.init(); session = value; return value;
    })().finally(() => { opening = undefined; });
    return opening;
  }
  return {
    workItems: async () => (await get()).workItems(),
    isModelReady: async () => (await get()).modelReady(),
    createSession: get,
    describe: async () => (await get()).describe(),
    configure: async selection => (await get()).configure(selection),
    compact: async () => (await get()).compact(),
    stop: async commandId => (await get()).abort(commandId),
    dispose: async () => { if (opening) await opening; await session?.dispose(); },
  };
}
