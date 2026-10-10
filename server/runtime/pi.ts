import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { clampThinkingLevel, getSupportedThinkingLevels, type Models, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, Harness, ROOT_CONVERSATION_ID, watchEvents, type AgentEvent, type AgentEventStream, type Conversation, type EntryRecord } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { CompactionResult, RuntimeDescription, RuntimeSelection } from "../../shared/runtime";
import type { WorkspacePaths } from "../domain/workspace";
import type { ChatRuntime, ChatSession, SessionContext, SessionEvent } from "./types";
import { SessionCancelledError } from "./types";
import { exportPiReference, readPiContext, sessionDirectory } from "./pi-context";
import { projectPiHistory, readPiEntries, readPiHistory, readPiInputs } from "./pi-history";
import { PiReplyEvents } from "./pi-events";
import { createWorkspaceResources, loadWorkspaceResources } from "./resources";
import { runtimePaths } from "./config/paths";
import { loadWorkspaceModels, requireAvailableModel, type WorkspaceModelConfig } from "./model-config";
import { installWorkspacePlugins, type WorkspaceRegistry } from "./extensions";
import { WorkspaceExecutionEnv } from "./execution-env";

export const PIKO_TOOL_NAMES = ["read", "write", "edit", "bash"];
const Interruptions = defineDoc<{ runs: string[] }>({ kind: "piko.interruptions", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({ runs: [] }) });

async function registry(paths: WorkspacePaths): Promise<WorkspaceRegistry> {
  const value = createRegistry();
  value.install(CodingTools);
  value.install(createWorkspaceResources(paths));
  return installWorkspacePlugins(paths.home, value);
}

/** One open native store per Thread. UI reads raw entries; provider context stays durable's responsibility. */
export class DurableChatSession implements ChatSession {
  private harness!: Harness;
  private conversation!: Conversation;
  private config!: WorkspaceModelConfig;
  private extensions!: WorkspaceRegistry;
  private entries: EntryRecord[] = [];
  private inputEntries = new Map<number, string>();
  private eventStream!: AgentEventStream;
  private observed = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private prompts = new Set<string>();
  private executionId?: string;
  private executionError?: Error;
  private admission: Promise<unknown> = Promise.resolve();
  private observationError?: Error;
  private delivery?: Promise<void>;
  private reply = new PiReplyEvents(event => this.emit(event));
  private listeners = new Set<(event: SessionEvent) => void>();
  private busy = false;
  private changing = false;
  private changeFinished?: Promise<void>;
  private abortRequested = false;
  private disposed = false;
  private closing?: Promise<void>;

  constructor(readonly paths: WorkspacePaths, readonly input: SessionContext, private readonly injected?: Models,
    private readonly onDispose?: () => void) {}

  get isStreaming() { return this.busy || this.changing; }
  get replySnapshot() { return this.reply.snapshot; }
  get closePromise() { return this.closing; }
  get messages() { return projectPiHistory(this.entries, this.inputEntries).messages; }
  get native() { return this.conversation; }
  get nativeHarness() { return this.harness; }

  async init(): Promise<void> {
    const config = await loadWorkspaceModels(this.paths.home, this.injected);
    const extensions = await registry(this.paths);
    try { await this.open(config, extensions); }
    catch (error) { await extensions.dispose(); throw error; }
  }

  private async open(config: WorkspaceModelConfig, extensions: WorkspaceRegistry): Promise<void> {
    const directory = sessionDirectory(runtimePaths(this.paths.home).sessions, this.input);
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
      const preferred = config.defaultModel;
      const selected = preferred ? await requireAvailableModel(config.models, preferred) : (await config.models.getAvailable())[0];
      const conversation = existing ?? await harness.root(ctx, { agent: {
        cwd: this.paths.workspace,
        ...(selected && { model: { provider: selected.provider, modelId: selected.id } }),
        thinkingLevel: preferred?.thinking ?? "off",
      } });
      // Preserve Piko's explicit-retry contract. Mark all inherited work aborted BEFORE enabling scheduling.
      await conversation.abort(ctx, { background: true });
      if (existing && selected && !(await conversation.agent(ctx)).model) await conversation.configure({
        model: { provider: selected.provider, modelId: selected.id }, thinkingLevel: preferred?.thinking ?? "off",
      }, ctx);
      if (this.input.interruptedRunIds.length) await conversation.commit(async tx => {
        const state = await tx.doc(Interruptions, conversation.id);
        for (const runId of this.input.interruptedRunIds) {
          if (state.runs.includes(runId)) continue;
          await tx.appendEntry(conversation.id, { kind: "piko.interrupted", data: { runId }, model: [{ role: "user",
            content: `Execution ${runId} was interrupted by a server restart. Saved messages are historical context. Do not resume or repeat that execution or its tools automatically; respond only to the next user request.`,
            timestamp: Date.now() }] });
          state.runs.push(runId);
        }
      }, ctx);
      this.harness = harness; this.conversation = conversation; this.config = config; this.extensions = extensions;
      const stream = this.eventStream = await watchEvents(harness, conversation.id, ctx);
      this.entries = await readPiEntries(harness);
      this.inputEntries = await readPiInputs(harness, this.entries);
      const through = stream.snapshot.entries.reduce((latest, entry) => Math.max(latest, entry.id), 0);
      this.reply.restore(this.entries.filter(entry => entry.id <= through), stream.snapshot);
      stream.start(events => this.delivery = this.observe(events));
      void stream.closed.then(end => {
        this.observationError = end.reason === "listener_error" ? end.error : new Error(`Durable event stream closed: ${end.reason}`);
        for (const observer of this.observed.values()) observer.reject(this.observationError);
        if (!this.disposed) console.error("Piko durable event stream closed:", end);
      });
    } catch (error) { await harness.close(ctx); throw error; }
  }

  private async observe(events: readonly AgentEvent[]) {
    for (const event of events) {
      if (event.type === "snapshot") {
        // The read can see later commits. Project only through this snapshot's revision; queued events follow it.
        this.entries = await readPiEntries(this.harness);
        // Compaction/reset can put a newer head marker before retained older entries.
        const through = event.entries.reduce((latest, entry) => Math.max(latest, entry.id), 0);
        this.reply.restore(this.entries.filter(entry => entry.id <= through), event);
        // Overflow can replace user-message events too; let clients reconcile their history without changing text cursors.
        if (this.prompts.size) this.emit({ type: "refresh" });
        if (!event.run) for (const [runId, observed] of this.observed) {
          const record = await this.harness.commit(tx => tx.submissionByRequest(this.conversation.id, runId), ctx);
          if ((record?.status === "done" && record.type === "input" && record.answer <= through)
            || (record?.status === "unanswered" && (record.entry === undefined || record.entry <= through))) observed.resolve();
        }
      } else {
        if ((event.type === "entry_appended" || event.type === "message_end")
          && event.entry.id > (this.entries.at(-1)?.id ?? 0)) this.entries.push(event.entry);
        this.reply.apply(event);
        if (event.type === "message_end" && event.entry.kind === "pi.user") this.emit({ type: "refresh" });
        if (event.type === "submission" && event.record.requestId
          && (event.record.status === "done" || event.record.status === "unanswered")) this.observed.get(event.record.requestId)?.resolve();
      }
    }
  }

  private emit(event: SessionEvent) {
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) { console.error("Piko output observer:", error); }
    }
  }

  subscribe(listener: (event: SessionEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async prompt(text: string, run?: { id: string; createdAt: number; executionId?: string }): Promise<void> {
    if (!run) throw new Error("A Piko Run identity is required.");
    const executionId = run.executionId ?? run.id;
    if (this.disposed || this.changing || this.busy && (!this.prompts.size || this.executionId !== executionId)) throw new Error("This conversation is already responding, reconfiguring or closed.");
    if (this.observationError) throw this.observationError;
    if (!this.busy) {
      this.executionId = executionId; this.reply.begin(executionId); this.abortRequested = false; this.executionError = undefined;
    }
    this.busy = true; this.prompts.add(run.id);
    const observed = Promise.withResolvers<void>();
    // A stream can close while the provider is still settling; attach a handler immediately.
    void observed.promise.catch(() => {});
    this.observed.set(run.id, { resolve: () => observed.resolve(), reject: observed.reject });
    try {
      const admission = this.admission.catch(() => {}).then(async () => {
        const agent = await this.conversation.agent(ctx);
        if (!agent.model) throw new Error("No model is configured. Add credentials and a profile in PIKO_HOME/config.");
        await requireAvailableModel(this.config.models, { provider: agent.model.provider, model: agent.model.modelId });
        if (this.abortRequested) throw this.executionError ?? new SessionCancelledError();
        const existing = await this.conversation.commit(async tx => {
          const record = await tx.submissionByRequest(this.conversation.id, run.id);
          if (!record) {
            if (!this.entries.some(entry => entry.kind === "piko.run" && entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) && entry.data.runId === executionId)) {
              const marker = await tx.appendEntry(this.conversation.id,
                { kind: "piko.run", data: { runId: executionId, createdAt: run.createdAt } });
              this.entries.push(marker);
            }
            await tx.appendEntry(this.conversation.id, { kind: "piko.input", data: { runId: run.id, executionId, createdAt: run.createdAt } });
          }
          return record;
        }, ctx);
        if (this.abortRequested) throw this.executionError ?? new SessionCancelledError();
        const submission = await this.conversation.submit({ type: "input", content: text, requestId: run.id, whenBusy: "steer" }, ctx);
        return { existing, submission };
      });
      this.admission = admission;
      const { existing, submission } = await admission;
      const settled = await submission.wait(ctx);
      // A failed run leaves queued inputs in the native inbox. Settle the entire execution without replaying them.
      if (settled.status === "unanswered" && settled.reason !== "aborted") {
        this.executionError ??= new Error(typeof settled.detail === "string" ? settled.detail : `Pi could not complete this reply: ${settled.reason}`);
        this.abortRequested = true;
        await this.conversation.abort(ctx);
      }
      await this.conversation.waitForIdle(ctx);
      // Submission.wait tracks execution, not delivery. Preserve all message boundaries before Run publishes done.
      if (!existing || (existing.status !== "done" && existing.status !== "unanswered")) await observed.promise;
      this.entries = await readPiEntries(this.harness);
      this.inputEntries = await readPiInputs(this.harness, this.entries);
      // Final history is authoritative, including multi-tool turns and recovered/aborted output.
      if (this.prompts.size === 1) this.reply.restore(this.entries);
      if (this.abortRequested) throw this.executionError ?? new SessionCancelledError();
      if (settled.status === "unanswered" && settled.reason === "aborted") throw this.executionError ?? new SessionCancelledError();
      if (settled.status === "unanswered" && settled.reason !== "aborted") throw new Error(
        typeof settled.detail === "string" ? settled.detail : `Pi could not complete this reply: ${settled.reason}`);
    } finally {
      this.observed.delete(run.id); this.prompts.delete(run.id);
      if (!this.prompts.size) { this.reply.finish(); this.executionId = undefined; this.busy = false; }
    }
  }

  abort() { this.abortRequested = true; return this.conversation.abort(ctx, { background: true }); }
  exportState() { return exportPiReference(runtimePaths(this.paths.home).sessions, this.input.threadId); }
  async history() {
    this.entries = await readPiEntries(this.harness);
    this.inputEntries = await readPiInputs(this.harness, this.entries);
    return projectPiHistory(this.entries, this.inputEntries);
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
  private requireIdle() { if (this.disposed || this.busy || this.changing) throw new Error("Stop the current reply before changing runtime configuration."); }
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
    await this.conversation.configure({ model: { provider: model.provider, modelId: model.id }, thinkingLevel: thinking }, ctx);
  }); }
  async describe(): Promise<RuntimeDescription> {
    const agent = await this.conversation.agent(ctx);
    const resources = await loadWorkspaceResources(this.paths);
    return { runtime: "pi-durable", ...(agent.model && { selection: { provider: agent.model.provider, model: agent.model.modelId, thinking: agent.thinkingLevel } }),
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

export async function createPiSession(paths: WorkspacePaths, input: SessionContext, models?: Models) {
  const session = new DurableChatSession(paths, input, models);
  await session.init(); return session;
}

/** Serialize opening, reading and changing stores; generation waits outside that admission line. */
export function createPiRuntime(paths: WorkspacePaths, options: { models?: Models } = {}): ChatRuntime {
  const sessions = new Map<string, DurableChatSession>();
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = tail.catch(() => {}).then(operation); tail = task; return task;
  };
  async function get(input?: SessionContext): Promise<DurableChatSession> {
    if (!input) throw new Error("A persistent Piko Thread is required.");
    const current = sessions.get(input.threadId);
    if (current && !current.closePromise) return current;
    if (current?.closePromise) await current.closePromise;
    const session = new DurableChatSession(paths, input, options.models, () => { sessions.delete(input.threadId); });
    await session.init(); sessions.set(input.threadId, session); return session;
  }
  return {
    isModelReady: () => serial(async () => {
      const active = [...sessions.values()].find(session => !session.closePromise);
      return active ? active.modelReady() : (await (await loadWorkspaceModels(paths.home, options.models)).models.getAvailable()).length > 0;
    }),
    createSession: input => serial(() => get(input)),
    readHistory: input => serial(async () => {
      sessionDirectory(runtimePaths(paths.home).sessions, input);
      const active = sessions.get(input.threadId);
      if (active && !active.closePromise) return active.history();
      if (active?.closePromise) await active.closePromise;
      const native = await readPiContext(runtimePaths(paths.home).sessions, input);
      if (!native) return { messages: [], runs: new Map() };
      try { return await readPiHistory(native.session); }
      finally { await native.session.close(ctx); }
    }),
    describe: input => serial(async () => (await get(input)).describe()),
    configure: (input, selection) => serial(async () => (await get(input)).configure(selection)),
    compact: async input => { const session = await serial(() => get(input)); return session.compact(); },
    stop: async input => { const session = await serial(() => get(input)); await session.abort(); },
    dispose: () => serial(async () => { for (const session of [...sessions.values()]) await session.dispose(); }),
  };
}
