import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, configure, Harness, ROOT_CONVERSATION_ID, InboxDoc, LiveDoc, type ConversationId, type Storage, type Registry } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { WorkspacePaths } from "../domain/workspace";
import type { ChatRuntime } from "./types";
import { RuntimeBusyError } from "./types";
import { DurableChatSession, Recovery } from "./pi-session";
import { sessionDirectory } from "./pi-context";
import { activeSubagentIds, createSubagentRuntime, prepareRestart, subagentIds } from "./subagent-runtime";
import { createSubagentTools } from "./subagent-tools";
import { childScope, sideChatScope } from "./background";
import { DurableAssistantTasks } from "./assistant-tasks";
import { createTaskTools } from "./task-tools";
import { TaskContext } from "./task-context";
import { TaskFiles } from "../domain/tasks";
import { createWorkspaceResources } from "./resources";
import { runtimePaths } from "./config/paths";
import { loadWorkspaceModels, requireAvailableModel, availableBackground, configuredBackground, type WorkspaceModelConfig } from "./model-config";
import { readConfigEnvironment } from "../config/files";
import { readApplicationSettings } from "../config";
import { createWebTools } from "./web-tools";
import { WorkspaceExecutionEnv } from "./execution-env";
import { createMemoryCurationExtension, MemoryCurationService } from "./memory-curation";
import { createPikoCodingTools } from "./coding-tools";
import { SideChatCreates, SideChatDoc, SideChatError, requireSideChat, sideChats } from "./side-chats";
import { SIDE_CHAT_TITLE_LIMIT, type SideChat, type UpdateSideChat } from "../../shared/side-chats";

export const PIKO_TOOL_NAMES = ["read", "write", "edit", "bash"];
const SIDE_CHAT_INSTRUCTIONS = "This is an independent side chat. Share workspace guidance, memory and skills, but not the main chat transcript. Do not curate global memory or manage saved tasks. You may delegate independent background work; its results return only to this side chat, never to the main chat. Shared workspace tools are not a sandbox.";

/** One owner for storage, scheduler and root-only services; per-chat controllers never close it. */
class PikoRuntime {
  private storage!: Storage;
  private harness!: Harness;
  private config!: WorkspaceModelConfig;
  private registry!: Registry;
  private searchConfigured = false;
  private tasks!: DurableAssistantTasks;
  private children!: ReturnType<typeof createSubagentRuntime>;
  private memory?: MemoryCurationService;
  private main!: DurableChatSession;
  private readonly sessions = new Map<ConversationId, Promise<DurableChatSession>>();
  private closing = false;
  private closed?: Promise<void>;
  constructor(private readonly paths: WorkspacePaths, private readonly models?: Models) {}

  async init() {
    const settings = readApplicationSettings(this.paths.home);
    const env = readConfigEnvironment(this.paths.home);
    const config = this.config = await loadWorkspaceModels({ home: this.paths.home, settings, env, models: this.models });
    const coding = await createPikoCodingTools();
    const background = () => availableBackground(config.models, config.background);
    const children = this.children = createSubagentRuntime({ storage: () => this.storage,
      canReport: async id => {
        if (this.closing) return false;
        const opening = this.sessions.get(id);
        if (!opening) return true;
        try { return (await opening).canReport; }
        catch { return !this.closing; }
      },
      background, onReply: reply => this.main.backgroundReply(reply) });
    const memory = createMemoryCurationExtension({ workspace: this.paths.workspace,
      bindings: () => this.main?.bindings ?? new Map(), background, coding });
    const web = createWebTools(env, { settings: settings.tools });
    this.searchConfigured = web.searchConfigured;
    const registry = this.registry = createRegistry();
    for (const extension of [coding, createWorkspaceResources(this.paths), web.extension, children.extension, createSubagentTools(children),
      createTaskTools(() => this.tasks), memory.extension]) registry.install(extension);
    const directory = sessionDirectory(runtimePaths(this.paths.home).sessions);
    const persisted = existsSync(join(directory, "main.jsonl"));
    const storage = this.storage = await openNodeJsonlStorage(directory, ctx, { fsync: true });
    try {
      this.harness = await Harness.open(storage, { models: config.models, registry,
        env: ({ cwd }) => new WorkspaceExecutionEnv(cwd ?? this.paths.workspace, runtimePaths(this.paths.home).tmp),
        settings: { ...config.harnessSettings, toolExecution: "sequential", steeringMode: "all" },
        onReport: error => console.error("Piko durable:", error),
      }, ctx);
    } catch (error) { await storage.close(ctx); throw error; }
    const harness = this.harness;
    try {
      const existing = await harness.conversation(ROOT_CONVERSATION_ID, ctx);
      if (persisted && !existing) throw new Error("Durable root conversation is missing.");
      const preferred = config.main;
      const selected = preferred ? await requireAvailableModel(config.models, preferred) : (await config.models.getAvailable())[0];
      const root = existing ?? await harness.root(ctx, { agent: { cwd: this.paths.workspace,
        ...(selected && { model: { provider: selected.provider, modelId: selected.id } }), thinkingLevel: preferred?.thinking ?? "off" } });
      if (existing && resolve((await root.agent(ctx)).cwd ?? this.paths.workspace) !== resolve(this.paths.workspace))
        throw new Error("The configured workspace differs from the saved conversation.");
      if (selected && !(await root.agent(ctx)).model) await root.configure({ model: { provider: selected.provider, modelId: selected.id }, thinkingLevel: preferred?.thinking ?? "off" }, ctx);
      const chats = await harness.commit(tx => sideChats(tx), ctx);
      const chatIds = [ROOT_CONVERSATION_ID, ...chats.map(chat => Number(chat.id) as ConversationId)];
      const interrupted: ConversationId[] = [];
      for (const id of chatIds) {
        const live = await harness.snapshot(LiveDoc, id, ctx);
        const inbox = await harness.snapshot(InboxDoc, id, ctx);
        if (live?.run || inbox?.items.some(item => item.mode !== "write")) interrupted.push(id);
      }
      // Apply the no-replay policy before enabling any scheduler or input.
      const recovery = await prepareRestart(harness, chatIds);
      for (const id of recovery.interruptedIds) if (!interrupted.includes(id)) interrupted.push(id);
      const rootAgent = await root.agent(ctx);
      const parentAgents = new Map([[ROOT_CONVERSATION_ID, rootAgent]]);
      for (const chat of chats) {
        const id = Number(chat.id) as ConversationId;
        const conversation = await harness.conversation(id, ctx);
        if (conversation) parentAgents.set(id, await conversation.agent(ctx));
      }
      await harness.commit(async tx => {
        const selection = configuredBackground(config.background);
        for (const owner of chatIds) {
          const parent = parentAgents.get(owner) ?? rootAgent;
          const scope = childScope(parent);
          for (const id of await subagentIds(tx, owner)) {
            const binding = (await tx.doc(TaskContext, id)).binding;
            await configure(tx, id, { ...(selection ? { model: { provider: selection.provider, modelId: selection.modelId }, thinkingLevel: selection.thinkingLevel }
              : { model: parent.model, thinkingLevel: parent.thinkingLevel }),
              cwd: binding ? new TaskFiles(this.paths.workspace).directory(binding.itemId) : parent.cwd, ...scope });
          }
        }
        // Refresh side tools without resetting a side chat's selected model or history.
        for (const chat of chats) await configure(tx, Number(chat.id) as ConversationId, {
          cwd: this.paths.workspace, ...sideChatScope(rootAgent), instructions: SIDE_CHAT_INSTRUCTIONS,
        });
        for (const id of interrupted) {
          (await tx.doc(Recovery, id)).interruption = "The previous work was interrupted by a server restart. Please resend if needed.";
          await tx.appendEntry(id, { kind: "piko.interrupted", model: [{ role: "user", content: "The previous work was interrupted. Saved messages are history. Do not resume or repeat tools automatically; act only on new requests.", timestamp: Date.now() }] });
        }
      }, ctx);
      this.main = await this.session();
      this.tasks = new DurableAssistantTasks(harness, this.paths.workspace, children, async () => {
        if (this.closing) throw new Error("Piko is shutting down.");
        if (!this.main.canReport) throw new RuntimeBusyError();
        await this.main.ensureReady();
      });
      this.memory = new MemoryCurationService(harness, memory.task, () => this.main.bindings);
      this.main.attachMemory(this.memory);
      harness.resume();
      this.tasks.start();
      await this.memory.start();
    } catch (error) { await this.close(); throw error; }
  }

  async session(id = ROOT_CONVERSATION_ID): Promise<DurableChatSession> {
    if (this.closing) throw new Error("Piko is shutting down.");
    if (id !== ROOT_CONVERSATION_ID) await this.harness.commit(tx => requireSideChat(tx, String(id)), ctx);
    let opening = this.sessions.get(id);
    if (!opening) {
      opening = (async () => {
        const conversation = await this.harness.conversation(id, ctx);
        if (!conversation) throw new SideChatError("Conversation not found.");
        const value = new DurableChatSession(this.paths, this.harness, this.storage, conversation, this.config, this.searchConfigured, async () => {
          if (this.closing) throw new Error("Piko is shutting down.");
          if (id !== ROOT_CONVERSATION_ID) await this.harness.commit(async tx => {
            if ((await requireSideChat(tx, String(id))).metadata.archivedAt !== null) throw new SideChatError("This side chat is archived.", 409);
          }, ctx);
        });
        try { await value.init(); return value; }
        catch (error) { await value.dispose(); throw error; }
      })();
      this.sessions.set(id, opening);
      void opening.catch(() => { this.sessions.delete(id); });
    }
    return opening;
  }
  async sideSession(value: string) {
    const { id } = await this.harness.commit(tx => requireSideChat(tx, value), ctx);
    return this.session(id);
  }
  tasksService() { return this.tasks; }
  async list() { return this.harness.commit(tx => sideChats(tx), ctx); }
  async create(requestId: string, title: string): Promise<SideChat> {
    const rootAgent = await this.main.native.agent(ctx);
    return this.harness.commit(async tx => {
      const request = await tx.doc(SideChatCreates, requestId, null);
      const existing = request.conversationId;
      if (existing !== null) {
        const found = await requireSideChat(tx, String(existing));
        return { id: String(found.id), ...found.metadata };
      }
      const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, created.id, { cwd: this.paths.workspace, model: rootAgent.model,
        thinkingLevel: rootAgent.thinkingLevel, ...sideChatScope(rootAgent),
        instructions: SIDE_CHAT_INSTRUCTIONS });
      const metadata = await tx.doc(SideChatDoc, created.id);
      metadata.title = validTitle(title); metadata.createdAt = Date.now();
      request.conversationId = Number(created.id);
      return { id: String(created.id), ...metadata };
    }, ctx);
  }
  async update(value: string, change: UpdateSideChat): Promise<SideChat> {
    const { id } = await this.harness.commit(tx => requireSideChat(tx, value), ctx);
    const save = () => this.harness.commit(async tx => {
      const { metadata } = await requireSideChat(tx, value);
      if (change.title !== undefined) metadata.title = validTitle(change.title);
      if (change.archived !== undefined) metadata.archivedAt = change.archived ? metadata.archivedAt ?? Date.now() : null;
    }, ctx);
    // Archive and input admission use the SAME conversation gate, avoiding submit/archive races.
    if (change.archived === true) await (await this.session(id)).archive(async () => {
      const jobs = await this.harness.commit(tx => activeSubagentIds(tx, id), ctx);
      if (jobs.length) await this.children.stop(this.harness, id, jobs, ctx);
      await save();
    });
    else await save();
    return this.harness.commit(async tx => ({ id: value, ...(await requireSideChat(tx, value)).metadata }), ctx);
  }
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    this.closed = (async () => {
      this.memory?.close();
      try {
        await this.tasks?.close();
        await Promise.allSettled([...this.sessions.values()].map(async value => (await value).dispose()));
      } finally { await this.harness?.close(ctx); }
    })();
    return this.closed;
  }
}
function validTitle(title: string) {
  if (typeof title !== "string" || !title.trim() || title.trim().length > SIDE_CHAT_TITLE_LIMIT) throw new SideChatError(`Title must contain 1–${SIDE_CHAT_TITLE_LIMIT} characters.`, 422);
  return title.trim();
}

export function createPiRuntime(paths: WorkspacePaths, options: { models?: Models } = {}): ChatRuntime {
  let opening: Promise<PikoRuntime> | undefined;
  let closing: Promise<void> | undefined;
  async function get() {
    if (closing) throw new Error("Piko is shutting down.");
    return opening ??= (async () => { const runtime = new PikoRuntime(paths, options.models); await runtime.init(); return runtime; })()
      .catch(error => { opening = undefined; throw error; });
  }
  const session = async (id?: string) => {
    const runtime = await get();
    if (id !== undefined && (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) throw new SideChatError("Side chat not found.");
    return id === undefined ? runtime.session() : runtime.sideSession(id);
  };
  return {
    tasks: async () => (await get()).tasksService(),
    sideChats: { list: async () => (await get()).list(), create: async (requestId, title) => (await get()).create(requestId, title),
      update: async (id, change) => (await get()).update(id, change) },
    isModelReady: async () => (await session()).modelReady(),
    createSession: session,
    describe: async id => (await session(id)).describe(),
    configure: async (selection, id) => (await session(id)).configure(selection),
    compact: async id => (await session(id)).compact(),
    stop: async (commandId, id) => (await session(id)).abort(commandId),
    dispose: () => closing ??= (async () => { if (opening) await (await opening).close(); })(),
  };
}
