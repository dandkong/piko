import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  ROOT_CONVERSATION_ID,
  type Harness,
  type ConversationId,
  type Storage,
} from "@earendil-works/pi-durable";
import type { WorkspacePaths } from "../workspace";
import type { ChatRuntime } from "./types";
import { RuntimeBusyError } from "./types";
import { DurableChatSession } from "./conversation-session";
import { createSubagentRuntime } from "./subagents/runtime";
import { createSubagentTools } from "./subagents/tools";
import { DurableAssistantTasks } from "./tasks/service";
import { createTaskTools } from "./tasks/tools";
import { BackgroundReplies } from "./background-replies";
import { createWorkspaceResources } from "./resources";
import {
  loadWorkspaceModels,
  availableBackground,
  type WorkspaceModelConfig,
} from "./model-config";
import { readConfigEnvironment } from "../config/files";
import { readApplicationSettings } from "../config";
import { createWebTools } from "./web-tools";
import {
  createMemoryCurationExtension,
  MemoryCurationService,
} from "./memory-curation";
import { createPikoCodingTools } from "./coding-tools";
import { SideChatError, requireSideChat } from "./side-chats";
import { SideChats } from "./side-chat-service";
import { openRuntime } from "./bootstrap";

/** One owner for storage, scheduler and root-only services; per-chat controllers never close it. */
class PikoRuntime {
  private storage!: Storage;
  sideChats!: SideChats;
  private harness!: Harness;
  private config!: WorkspaceModelConfig;
  private readonly replies = new BackgroundReplies();
  private searchConfigured = false;
  private tasks!: DurableAssistantTasks;
  private memory?: MemoryCurationService;
  private main!: DurableChatSession;
  private readonly sessions = new Map<
    ConversationId,
    Promise<DurableChatSession>
  >();
  private closing = false;
  private closed?: Promise<void>;
  constructor(
    private readonly paths: WorkspacePaths,
    private readonly models?: Models,
  ) {}

  async init() {
    const settings = readApplicationSettings(this.paths.home);
    const env = readConfigEnvironment(this.paths.home);
    const config = (this.config = await loadWorkspaceModels({
      home: this.paths.home,
      settings,
      env,
      models: this.models,
    }));
    const coding = await createPikoCodingTools();
    const background = () =>
      availableBackground(config.models, config.background);
    const children = createSubagentRuntime({
      storage: () => this.storage,
      acceptReport: async (id, operation) => {
        if (this.closing) return false;
        try {
          return await (await this.session(id)).receiveReport(operation);
        } catch (error) {
          // A permanently archived/missing owner consumes the report without waking it.
          if (error instanceof SideChatError) return true;
          throw error;
        }
      },
      background,
      onReply: (reply) => this.replies.publish(reply),
    });
    const memory = createMemoryCurationExtension({
      workspace: this.paths.workspace,
      bindings: () => this.main?.bindings ?? new Map(),
      background,
      coding,
    });
    const web = createWebTools(env, { settings: settings.tools });
    this.searchConfigured = web.searchConfigured;
    const registry = createRegistry();
    for (const extension of [
      coding,
      createWorkspaceResources(this.paths),
      web.extension,
      children.extension,
      createSubagentTools(children),
      createTaskTools(() => this.tasks),
      memory.extension,
    ])
      registry.install(extension);
    const opened = await openRuntime(this.paths, config, registry);
    this.storage = opened.storage;
    const harness = (this.harness = opened.harness);
    this.sideChats = new SideChats(
      harness,
      this.paths.workspace,
      children,
      (id) => this.session(id),
      () => this.main.native.agent(ctx),
    );
    try {
      this.main = await this.session();
      this.tasks = new DurableAssistantTasks(
        harness,
        this.paths.workspace,
        children,
        async () => {
          if (this.closing) throw new Error("Piko is shutting down.");
          if (!this.main.canReport) throw new RuntimeBusyError();
          await this.main.ensureReady();
        },
      );
      this.memory = new MemoryCurationService(
        harness,
        memory.task,
        () => this.main.bindings,
      );
      this.main.attachMemory(this.memory);
      harness.resume();
      this.tasks.start();
      await this.memory.start();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async session(id = ROOT_CONVERSATION_ID): Promise<DurableChatSession> {
    if (this.closing) throw new Error("Piko is shutting down.");
    if (id !== ROOT_CONVERSATION_ID)
      await this.harness.commit((tx) => requireSideChat(tx, String(id)), ctx);
    let opening = this.sessions.get(id);
    if (!opening) {
      opening = (async () => {
        const conversation = await this.harness.conversation(id, ctx);
        if (!conversation) throw new SideChatError("Conversation not found.");
        const value = new DurableChatSession(
          this.paths,
          this.harness,
          this.storage,
          conversation,
          this.config,
          this.searchConfigured,
          async () => {
            if (this.closing) throw new Error("Piko is shutting down.");
            if (id !== ROOT_CONVERSATION_ID)
              await this.harness.commit(async (tx) => {
                if (
                  (await requireSideChat(tx, String(id))).metadata
                    .archivedAt !== null
                )
                  throw new SideChatError("This side chat is archived.", 409);
              }, ctx);
          },
          id === ROOT_CONVERSATION_ID ? this.replies : undefined,
        );
        try {
          await value.init();
          return value;
        } catch (error) {
          await value.dispose();
          throw error;
        }
      })();
      this.sessions.set(id, opening);
      void opening.catch(() => {
        this.sessions.delete(id);
      });
    }
    return opening;
  }
  async sideSession(value: string) {
    const { id } = await this.harness.commit(
      (tx) => requireSideChat(tx, value),
      ctx,
    );
    return this.session(id);
  }
  tasksService() {
    return this.tasks;
  }
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    this.closed = (async () => {
      this.memory?.close();
      try {
        await this.tasks?.close();
        await Promise.allSettled(
          [...this.sessions.values()].map(async (value) =>
            (await value).dispose(),
          ),
        );
      } finally {
        this.replies.close();
        await this.harness?.close(ctx);
      }
    })();
    return this.closed;
  }
}

export function createPiRuntime(
  paths: WorkspacePaths,
  options: { models?: Models } = {},
): ChatRuntime {
  let opening: Promise<PikoRuntime> | undefined;
  let closing: Promise<void> | undefined;
  async function get() {
    if (closing) throw new Error("Piko is shutting down.");
    return (opening ??= (async () => {
      const runtime = new PikoRuntime(paths, options.models);
      await runtime.init();
      return runtime;
    })().catch((error) => {
      opening = undefined;
      throw error;
    }));
  }
  const session = async (id?: string) => {
    const runtime = await get();
    if (
      id !== undefined &&
      (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
    )
      throw new SideChatError("Side chat not found.");
    return id === undefined ? runtime.session() : runtime.sideSession(id);
  };
  return {
    tasks: async () => (await get()).tasksService(),
    sideChats: {
      list: async () => (await get()).sideChats.list(),
      create: async (requestId, title) =>
        (await get()).sideChats.create(requestId, title),
      update: async (id, change) => (await get()).sideChats.update(id, change),
    },
    isModelReady: async () => (await session()).modelReady(),
    createSession: session,
    describe: async (id) => (await session(id)).describe(),
    configure: async (selection, id) =>
      (await session(id)).configure(selection),
    compact: async (id) => (await session(id)).compact(),
    stop: async (commandId, id) => (await session(id)).abort(commandId),
    dispose: () =>
      (closing ??= (async () => {
        if (opening) await (await opening).close();
      })()),
  };
}
