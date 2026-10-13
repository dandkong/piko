import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { clampThinkingLevel, getSupportedThinkingLevels, type Models, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineDocFamily, InboxDoc, LiveDoc, Harness, ROOT_CONVERSATION_ID, watchEvents, type AgentEvent, type AgentEventStream, type Conversation, type EntryRecord, type SubmissionRecord, type SubmissionId, type TaskId, type Storage, type Cursor, configure as configureAgent } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { CompactionResult, RuntimeDescription, RuntimeSelection } from "../../shared/runtime";
import type { WorkspacePaths } from "../domain/workspace";
import type { BackgroundReply, InputSource, ChatRuntime, ChatSession, SessionEvent } from "./types";
import { SessionCancelledError } from "./types";
import { readPiContext, sessionDirectory } from "./pi-context";
import { entriesFromTransaction, inputsFromStorage, messageText, projectPiHistory, readPiEntries, readPiHistory, readPiInputs } from "./pi-history";
import { PiMessageEvents } from "./pi-events";
import { createSubagentExtension, prepareRestart, subagentIds } from "./subagents";
import { internalInput, registerInput } from "./input-origin";
import { createWorkspaceResources, loadWorkspaceResources } from "./resources";
import { runtimePaths } from "./config/paths";
import { loadWorkspaceModels, requireAvailableModel, type WorkspaceModelConfig } from "./model-config";
import { installWorkspacePlugins, type WorkspaceRegistry } from "./extensions";
import { readConfigEnvironment } from "../config/files";
import { BUILTIN_WEB_TOOL_NAMES, createWebTools } from "./web-tools";
import { WorkspaceExecutionEnv } from "./execution-env";

export const PIKO_TOOL_NAMES = ["read", "write", "edit", "bash"];
const Recovery = defineDoc<{ interruption: string }>({ kind: "piko.recovery", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ interruption: "" }) });
const StopReceipts = defineDocFamily<{ processed: boolean; stopped: boolean; tasks: number[] }, null>({ kind: "piko.stop", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true, initial: () => ({ processed: false, stopped: false, tasks: [] }) });
function receipt(record: SubmissionRecord): import("../../shared/chat").SubmissionReceipt {
  return { id: String(record.id), ...(record.requestId && { requestId: record.requestId }), status: record.status,
    ...(record.status === "unanswered" && { error: typeof record.detail === "string" ? record.detail : record.reason }) };
}

type SessionRegistry = WorkspaceRegistry & { searchConfigured: boolean };
async function registry(paths: WorkspacePaths, subagents: import("@earendil-works/pi-durable").Extension): Promise<SessionRegistry> {
  const value = createRegistry();
  const web = createWebTools(readConfigEnvironment(paths.home));
  value.install(CodingTools);
  value.install(createWorkspaceResources(paths));
  value.install(web.extension);
  value.install(subagents);
  return { ...await installWorkspacePlugins(paths.home, value, BUILTIN_WEB_TOOL_NAMES), searchConfigured: web.searchConfigured };
}

/** One native Harness and root conversation per PIKO_HOME. UI reads raw entries; provider context stays durable's responsibility. */
export class DurableChatSession implements ChatSession {
  private harness!: Harness;
  private storage!: Storage;
  private conversation!: Conversation;
  private config!: WorkspaceModelConfig;
  private extensions!: SessionRegistry;
  private entries: EntryRecord[] = [];
  private inputEntries = new Map<number, string>();
  private eventStream!: AgentEventStream;
  private admission: Promise<unknown> = Promise.resolve();
  private monitors = new Set<Promise<void>>();
  private failureCleanup?: Promise<void>;
  private stopping = false;
  private liveBusy = false;
  private observationError?: Error;
  private delivery?: Promise<void>;
  private deliveredEntry = 0;
  private deliveryWaiters = new Set<{ entry: number; resolve: () => void; reject: (error: Error) => void }>();
  private output = new PiMessageEvents(event => this.emit(event));
  private hiddenEntries = new Set<number>();
  private replyListeners = new Set<(reply: BackgroundReply) => Promise<void>>();
  private pendingReplies: BackgroundReply[] = [];
  private previousIds = new Map<string, string>();
  private listeners = new Set<(event: SessionEvent) => void>();
  private busy = false;
  private changing = false;
  private changeFinished?: Promise<void>;
  private disposed = false;
  private closing?: Promise<void>;

  constructor(readonly paths: WorkspacePaths, private readonly injected?: Models,
    private readonly onDispose?: () => void) {}

  get isStreaming() { return this.busy || this.changing || this.stopping || this.liveBusy; }
  get closePromise() { return this.closing; }
  get messages() {
    const messages = projectPiHistory(this.entries, this.inputEntries, this.hiddenEntries).messages;
    const partial = this.output.partial(this.entries);
    return partial?.content.trim() ? [...messages, partial] : messages;
  }
  get native() { return this.conversation; }
  get nativeHarness() { return this.harness; }

  async init(): Promise<void> {
    const config = await loadWorkspaceModels(this.paths.home, this.injected);
    const extensions = await registry(this.paths, createSubagentExtension({ storage: () => this.storage,
      canReport: () => !this.busy && !this.changing && !this.stopping && !this.disposed,
      onReply: async reply => {
        if (!this.replyListeners.size) { if (reply.source.channel === "telegram") this.pendingReplies.push(reply); return; }
        await Promise.allSettled([...this.replyListeners].map(listener => listener(reply)));
      },
    }));
    try { await this.open(config, extensions); }
    catch (error) { await extensions.dispose(); throw error; }
  }

  private async open(config: WorkspaceModelConfig, extensions: SessionRegistry): Promise<void> {
    const directory = sessionDirectory(runtimePaths(this.paths.home).sessions);
    const persisted = existsSync(join(directory, "main.jsonl"));
    const storage = await openNodeJsonlStorage(directory, ctx, { fsync: true });
    let harness: Harness;
    try {
      harness = await Harness.open(storage, { models: config.models, registry: extensions.registry,
        env: ({ cwd }) => new WorkspaceExecutionEnv(cwd ?? this.paths.workspace, runtimePaths(this.paths.home).tmp),
        settings: { ...config.harnessSettings, toolExecution: "sequential", steeringMode: "all" },
        onReport: error => console.error("Piko durable:", error),
      }, ctx);
    } catch (error) { await storage.close(ctx); throw error; }
    try {
      const existing = await harness.conversation(ROOT_CONVERSATION_ID, ctx);
      if (persisted && !existing) throw new Error("Durable root conversation is missing.");
      const preferred = config.defaultModel;
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
      // Registry/plugin configuration is rebuilt at startup; children share the current root selection.
      const rootAgent = await conversation.agent(ctx);
      await harness.commit(async tx => {
        const ids = await subagentIds(tx);
        for (const id of ids) await configureAgent(tx, id, { model: rootAgent.model, thinkingLevel: rootAgent.thinkingLevel,
          cwd: rootAgent.cwd, extensions: rootAgent.extensions.filter(item => item.name !== "piko-subagents"),
          tools: rootAgent.tools.filter(item => item.name !== "subagent") });
      }, ctx);
      this.storage = storage; this.harness = harness; this.conversation = conversation; this.config = config; this.extensions = extensions;
      const stream = this.eventStream = await watchEvents(harness, conversation.id, ctx);
      this.entries = await readPiEntries(harness);
      this.inputEntries = await readPiInputs(harness, storage);
      this.hiddenEntries = await harness.commit(async tx => {
        const hidden = new Set<number>();
        for (const [entry, requestId] of this.inputEntries) if (await internalInput(tx, requestId)) hidden.add(entry);
        return hidden;
      }, ctx);
      const through = stream.snapshot.entries.reduce((latest, entry) => Math.max(latest, entry.id), 0);
      this.output.restore(this.entries.filter(entry => entry.id <= through), stream.snapshot, true);
      stream.start(events => this.delivery = this.observe(events));
      harness.resume();
      void stream.closed.then(end => {
        this.observationError = end.reason === "listener_error" ? end.error : new Error(`Durable event stream closed: ${end.reason}`);
        for (const waiter of this.deliveryWaiters) waiter.reject(this.observationError); this.deliveryWaiters.clear();
        if (!this.disposed) console.error("Piko durable event stream closed:", end);
      });
    } catch (error) { await harness.close(ctx); throw error; }
  }

  private async observe(events: readonly AgentEvent[]) {
    for (const event of events) {
      if (event.type === "snapshot") {
        this.entries = await readPiEntries(this.harness);
        const through = event.entries.reduce((latest, entry) => Math.max(latest, entry.id), 0);
        this.output.restore(this.entries.filter(entry => entry.id <= through), event);
        this.deliveredEntry = Math.max(this.deliveredEntry, through);
        this.liveBusy = !!event.run;
        this.emit({ type: "refresh" });
      } else {
        if ((event.type === "entry_appended" || event.type === "message_end") && event.entry.id > (this.entries.at(-1)?.id ?? 0)) this.entries.push(event.entry);
        this.output.apply(event);
        if (event.type === "entry_appended" || event.type === "message_end") this.deliveredEntry = Math.max(this.deliveredEntry, event.entry.id);
        if (event.type === "run_start") this.liveBusy = true;
        if (event.type === "run_end") this.liveBusy = false;
        if (event.type === "message_end" || event.type === "run_start" || event.type === "run_end" || event.type === "submission") this.emit({ type: "refresh" });
      }
    }
    for (const waiter of this.deliveryWaiters) if (waiter.entry <= this.deliveredEntry) { this.deliveryWaiters.delete(waiter); waiter.resolve(); }
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
  async snapshot() {
    const state = await this.harness.commit(async tx => {
      const entries = await entriesFromTransaction(tx);
      const inputs = await inputsFromStorage(this.storage);
      const hidden = new Set<number>();
      for (const [entry, requestId] of inputs) if (await internalInput(tx, requestId)) hidden.add(entry);
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
      return { entries, inputs, hidden, running: !!live.run || inbox.items.some(item => item.mode !== "write"), queued, latest, interruption: recovery.interruption };
    }, ctx);
    this.entries = state.entries; this.inputEntries = state.inputs; this.hiddenEntries = state.hidden; this.liveBusy = state.running;
    return { messages: [...this.messages, ...state.queued], busy: this.isStreaming, previousIds: Object.fromEntries(this.previousIds),
      ...(state.latest && { latest: receipt(state.latest) }), ...(state.interruption && { interruption: state.interruption }) };
  }
  async submit(text: string, requestId: string, source: InputSource = { channel: "app" }) {
    if (requestId.startsWith("piko:")) throw new Error("Reserved input identity.");
    const task = this.admission.catch(() => {}).then(async () => {
      if (this.disposed || this.changing || this.busy || this.stopping) throw new Error("Piko is busy with maintenance or stopping.");
      if (this.observationError) throw this.observationError;
      await this.failureCleanup;
      const existing = await this.submission(requestId);
      if (existing) return { submission: existing, duplicate: true };
      const agent = await this.conversation.agent(ctx);
      if (!agent.model) throw new Error("No model is configured. Add credentials and a profile in PIKO_HOME/config.");
      await requireAvailableModel(this.config.models, { provider: agent.model.provider, model: agent.model.modelId });
      await this.conversation.commit(async tx => { (await tx.doc(Recovery, this.conversation.id)).interruption = ""; await registerInput(tx, requestId, source); }, ctx);
      const handle = await this.conversation.submit({ type: "input", content: text, requestId, whenBusy: "steer" }, ctx);
      this.liveBusy = true;
      const monitor = handle.wait(ctx).then(async settled => {
        if (settled.status === "unanswered" && settled.reason !== "aborted" && settled.reason !== "withdrawn_after_failure") {
          this.emit({ type: "error", message: typeof settled.detail === "string" ? settled.detail : settled.reason });
          this.failureCleanup = (async () => {
            await this.conversation.commit(async tx => {
              const inbox = await tx.doc(InboxDoc, this.conversation.id);
              for (const item of inbox.items) if (item.mode !== "write") tx.settleSubmission(item.id,
                { status: "unanswered", reason: "withdrawn_after_failure", detail: typeof settled.detail === "string" ? settled.detail : settled.reason });
              inbox.items = inbox.items.filter(item => item.mode === "write");
            }, ctx);
            await this.abort();
          })();
          await this.failureCleanup;
        }
        this.emit({ type: "refresh" });
      }).catch(error => { if (!this.disposed) this.emit({ type: "error", message: error instanceof Error ? error.message : "Reply failed." }); });
      this.monitors.add(monitor); void monitor.finally(() => this.monitors.delete(monitor));
      return { submission: receipt(await handle.status(ctx)), duplicate: false };
    });
    this.admission = task; return task;
  }
  /** Convenience for native adapter tests and callers that need to await completion. */
  async prompt(text: string, input: { id: string; createdAt: number }) {
    const admitted = await this.submit(text, input.id);
    const handle = await this.harness.submission(Number(admitted.submission.id) as SubmissionId, ctx);
    const settled = await handle!.wait(ctx);
    await this.conversation.waitForIdle(ctx);
    await this.failureCleanup;
    const entry = settled.type === "input" && settled.status === "done" ? settled.answer : settled.entry;
    if (entry !== undefined && entry > this.deliveredEntry && !this.observationError) await new Promise<void>((resolve, reject) => { this.deliveryWaiters.add({ entry, resolve, reject }); });
    await this.delivery;
    if (this.observationError) throw this.observationError;
    if (settled.status === "unanswered") throw settled.reason === "aborted" ? new SessionCancelledError() : new Error(typeof settled.detail === "string" ? settled.detail : settled.reason);
  }
  async abort(commandId?: string): Promise<boolean> {
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
    await this.eventStream.stop();
    // Listener errors are already reported by stream.closed; still release the store and plugin resources.
    await this.delivery?.catch(() => {});
    await this.harness.close(ctx);
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    this.closing = (async () => {
      await this.changeFinished?.catch(() => {});
      await this.closeNative(); await this.extensions.dispose(); this.listeners.clear(); this.onDispose?.();
    })();
    return this.closing;
  }
  private requireIdle() { if (this.disposed || this.isStreaming) throw new Error("Stop the current reply before changing runtime configuration."); }
  private async change(operation: () => Promise<void>) {
    this.requireIdle();
    this.changing = true;
    this.changeFinished = operation();
    try { await this.changeFinished; } finally { this.changing = false; this.changeFinished = undefined; }
  }
  async configure(selection: RuntimeSelection) { return this.change(async () => {
    const agent = await this.conversation.agent(ctx);
    const profile = "profile" in selection ? (Object.hasOwn(this.config.profiles, selection.profile) ? this.config.profiles[selection.profile] : undefined)
      : "provider" in selection ? selection
      : agent.model && { provider: agent.model.provider, model: agent.model.modelId, thinking: selection.thinking };
    if (!profile) throw new Error("Unknown profile or no current model.");
    const model = await requireAvailableModel(this.config.models, profile);
    const thinking = profile.thinking ?? ("provider" in selection ? clampThinkingLevel(model, agent.thinkingLevel) : "off");
    if (!getSupportedThinkingLevels(model).includes(thinking)) throw new Error("This model does not support that thinking level.");
    await this.harness.commit(async tx => {
      const ids = await subagentIds(tx);
      const selection = { model: { provider: model.provider, modelId: model.id }, thinkingLevel: thinking };
      await configureAgent(tx, this.conversation.id, selection);
      for (const id of ids) await configureAgent(tx, id, selection);
    }, ctx);
  }); }
  async describe(): Promise<RuntimeDescription> {
    const agent = await this.conversation.agent(ctx);
    const resources = await loadWorkspaceResources(this.paths);
    const pluginNames = new Set(this.extensions.plugins.map(plugin => plugin.name));
    const owners = new Map(this.extensions.registry.snapshot().tools()
      .filter(item => agent.extensions.some(extension => extension.name === item.extension.name))
      .map(item => [item.tool.name, item.extension.name]));
    const tools = agent.tools.map(tool => ({ name: tool.name,
      source: pluginNames.has(owners.get(tool.name) ?? "") ? "extension" as const : "builtin" as const,
      status: tool.name === "web_search" && !this.extensions.searchConfigured ? "unconfigured" as const : "available" as const }));
    return { runtime: "pi-durable", tools, ...(agent.model && { selection: { provider: agent.model.provider, model: agent.model.modelId, thinking: agent.thinkingLevel } }),
      models: (await this.config.models.getAvailable()).map(model => ({ provider: model.provider, id: model.id, name: model.name,
        imageInput: model.input.includes("image"), contextWindow: model.contextWindow, thinkingLevels: getSupportedThinkingLevels(model) as ModelThinkingLevel[] })),
      profiles: this.config.profiles, skills: resources.skills, plugins: this.extensions.plugins };
  }
  async modelReady() { return (await this.config.models.getAvailable()).length > 0; }
  async compact(): Promise<CompactionResult> {
    this.requireIdle();
    this.busy = true;
    try {
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
    } finally { this.busy = false; }
  }
}

export async function createPiSession(paths: WorkspacePaths, models?: Models) {
  const session = new DurableChatSession(paths, models);
  await session.init(); return session;
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
    isModelReady: async () => session && !session.closePromise ? session.modelReady() : (await (await loadWorkspaceModels(paths.home, options.models)).models.getAvailable()).length > 0,
    createSession: get,
    readHistory: async () => {
      if (session && !session.closePromise) return session.snapshot();
      if (opening) return (await opening).snapshot();
      if (session?.closePromise) await session.closePromise;
      const native = await readPiContext(runtimePaths(paths.home).sessions);
      if (!native) return { messages: [], busy: false };
      try { return { ...await readPiHistory(native.session, native.storage), busy: false }; } finally { await native.session.close(ctx); }
    },
    describe: async () => (await get()).describe(),
    configure: async selection => (await get()).configure(selection),
    compact: async () => (await get()).compact(),
    stop: async commandId => (await get()).abort(commandId),
    dispose: async () => { if (opening) await opening; await session?.dispose(); },
  };
}
