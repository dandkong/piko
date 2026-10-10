import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { clampThinkingLevel, getSupportedThinkingLevels, type Models, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, Harness, ROOT_CONVERSATION_ID, type Conversation, type EntryRecord, type LiveState } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { StreamEvent } from "../../shared/chat";
import type { RuntimeDescription, RuntimeSelection } from "../../shared/runtime";
import type { WorkspacePaths } from "../domain/workspace";
import type { ChatRuntime, ChatSession, SessionContext } from "./types";
import { exportPiReference, readPiContext, sessionDirectory } from "./pi-context";
import { messageText, projectPiHistory, readPiEntries } from "./pi-history";
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
  private unsubscribe?: () => void;
  private releaseView?: () => void;
  private listeners = new Set<(event: StreamEvent) => void>();
  private busy = false;
  private changing = false;
  private changeFinished?: Promise<void>;
  private abortRequested = false;
  private disposed = false;
  private closing?: Promise<void>;
  private emitted = "";
  private completedText = "";
  private partial = "";
  private attempt?: string;

  constructor(readonly paths: WorkspacePaths, readonly input: SessionContext, private readonly injected?: Models,
    private readonly onDispose?: () => void) {}

  get isStreaming() { return this.busy || this.changing; }
  get closePromise() { return this.closing; }
  get messages() { return projectPiHistory(this.entries).messages; }
  get native() { return this.conversation; }
  get nativeHarness() { return this.harness; }

  async init(): Promise<void> {
    const config = await loadWorkspaceModels(this.paths.home, this.injected);
    const extensions = await registry(this.paths);
    try { await this.open(config, extensions, true); }
    catch (error) { await extensions.dispose(); throw error; }
  }

  private async open(config: WorkspaceModelConfig, extensions: WorkspaceRegistry, recover: boolean): Promise<void> {
    const directory = sessionDirectory(runtimePaths(this.paths.home).sessions, this.input);
    const storage = await openNodeJsonlStorage(directory, ctx, { fsync: true });
    let harness: Harness;
    try {
      harness = await Harness.open(storage, { models: config.models, registry: extensions.registry,
        env: ({ cwd }) => new WorkspaceExecutionEnv(cwd ?? this.paths.workspace, runtimePaths(this.paths.home).tmp),
        settings: { ...config.harnessSettings, toolExecution: "sequential" },
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
      if (recover) await conversation.abort(ctx, { background: true });
      if (existing && selected && !(await conversation.agent(ctx)).model) await conversation.configure({
        model: { provider: selected.provider, modelId: selected.id }, thinkingLevel: preferred?.thinking ?? "off",
      }, ctx);
      if (recover && this.input.interruptedRunIds.length) await conversation.commit(async tx => {
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
      this.entries = await readPiEntries(harness);
      const view = await conversation.viewState(ctx);
      this.releaseView = () => view.dispose();
      this.unsubscribe = harness.subscribeCommits(publication => {
        let live: LiveState | undefined;
        for (const change of publication.changes) {
          if (change.type === "entry" && change.value.conversationId === conversation.id) {
            this.entries.push(change.value);
            const message = change.value.kind === "pi.assistant" && change.value.model?.[0];
            if (this.busy && message && message.role === "assistant") {
              this.partial = messageText(message.content); this.publishText();
              this.completedText += this.partial; this.partial = ""; this.attempt = undefined;
            }
          } else if (change.type === "document" && change.conversationId === conversation.id
            && change.record.kind === "pi.live" && change.value !== null) live = change.value as LiveState;
        }
        if (this.busy && live?.generation?.message && live.run) {
          const attempt = `${live.run.taskId}:${live.generation.attempt}`;
          if (attempt !== this.attempt) { this.partial = ""; this.attempt = attempt; }
          this.partial = messageText(live.generation.message.content); this.publishText();
        }
      });
    } catch (error) { await harness.close(ctx); throw error; }
  }

  private publishText() {
    const text = this.completedText + this.partial;
    if (text === this.emitted) return;
    const event: StreamEvent = text.startsWith(this.emitted)
      ? { type: "delta", text: text.slice(this.emitted.length) } : { type: "replace", text };
    this.emitted = text;
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) { console.error("Piko output observer:", error); }
    }
  }

  subscribe(listener: (event: StreamEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async prompt(text: string, run?: { id: string; createdAt: number }): Promise<void> {
    if (!run) throw new Error("A Piko Run identity is required.");
    if (this.disposed || this.busy || this.changing) throw new Error("This conversation is already responding, reconfiguring or closed.");
    this.busy = true; this.completedText = ""; this.partial = ""; this.emitted = ""; this.attempt = undefined;
    this.abortRequested = false;
    try {
      const agent = await this.conversation.agent(ctx);
      if (!agent.model) throw new Error("No model is configured. Add credentials and a profile in PIKO_HOME/config.");
      await requireAvailableModel(this.config.models, { provider: agent.model.provider, model: agent.model.modelId });
      if (this.abortRequested) return;
      await this.conversation.commit(async tx => {
        if (!await tx.submissionByRequest(this.conversation.id, run.id)) await tx.appendEntry(this.conversation.id,
          { kind: "piko.run", data: { runId: run.id, createdAt: run.createdAt } });
      }, ctx);
      if (this.abortRequested) return;
      const submission = await this.conversation.submit({ type: "input", content: text, requestId: run.id }, ctx);
      const settled = await submission.wait(ctx);
      await this.conversation.waitForIdle(ctx);
      this.entries = await readPiEntries(this.harness);
      // Final history is authoritative, including multi-tool turns and recovered/aborted output.
      const saved = projectPiHistory(this.entries).runs.get(run.id)?.text ?? "";
      this.completedText = saved; this.partial = ""; this.publishText();
      if (settled.status === "unanswered" && settled.reason !== "aborted") throw new Error(
        typeof settled.detail === "string" ? settled.detail : `Pi could not complete this reply: ${settled.reason}`);
    } finally { this.busy = false; }
  }

  abort() { this.abortRequested = true; return this.conversation.abort(ctx, { background: true }); }
  exportState() { return exportPiReference(runtimePaths(this.paths.home).sessions, this.input.threadId); }
  async history() { this.entries = await readPiEntries(this.harness); return projectPiHistory(this.entries); }
  private async closeNative() { this.unsubscribe?.(); this.releaseView?.(); await this.harness.close(ctx); }
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
  async reload() { return this.change(async () => {
    const config = await loadWorkspaceModels(this.paths.home, this.injected);
    const extensions = await registry(this.paths);
    try {
      const agent = await this.conversation.agent(ctx);
      if (agent.model) {
        const model = await requireAvailableModel(config.models, { provider: agent.model.provider, model: agent.model.modelId });
        if (!getSupportedThinkingLevels(model).includes(agent.thinkingLevel)) throw new Error("The current thinking level is not supported by the updated model.");
      }
    } catch (error) { await extensions.dispose(); throw error; }
    const oldConfig = this.config, oldExtensions = this.extensions;
    await this.closeNative();
    try { await this.open(config, extensions, false); }
    catch (error) { await extensions.dispose(); await this.open(oldConfig, oldExtensions, false); throw error; }
    await oldExtensions.dispose();
  }); }
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
  async compact() {
    this.requireIdle();
    this.busy = true;
    try {
      const task = await this.conversation.compact(undefined, ctx);
      const settled = await this.harness.waitForTask(task, ctx);
      if (settled.state.outcome.status === "failed" || settled.state.outcome.status === "faulted") throw new Error(settled.state.outcome.error.message);
      if (settled.state.outcome.status === "completed" && settled.state.outcome.result.submissionId) {
        await (await this.harness.submission(settled.state.outcome.result.submissionId, ctx))?.wait(ctx);
      }
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
      try { return projectPiHistory(await readPiEntries(native.session)); }
      finally { await native.session.close(ctx); }
    }),
    describe: input => serial(async () => (await get(input)).describe()),
    configure: (input, selection) => serial(async () => (await get(input)).configure(selection)),
    reload: input => serial(async () => (await get(input)).reload()),
    compact: async input => { const session = await serial(() => get(input)); await session.compact(); },
    stop: async input => { const session = await serial(() => get(input)); await session.abort(); },
    dispose: () => serial(async () => { for (const session of [...sessions.values()]) await session.dispose(); }),
  };
}
