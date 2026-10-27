import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel, type Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  ROOT_CONVERSATION_ID,
  type Harness,
  type ConversationId,
  type Storage,
} from "@earendil-works/pi-durable";
import type { WorkspacePaths } from "../workspace";
import type { RuntimeSelection } from "../../shared/runtime";
import type { AssistantSubagentsRuntime, ChatRuntime } from "./types";
import { RuntimeBusyError } from "./types";
import { DurableChatSession } from "./conversation-session";
import { createSubagentRuntime } from "./subagents/runtime";
import { delegationStatus, listDelegations } from "./subagents/delegations";
import { createSubagentTools } from "./subagents/tools";
import { DurableAssistantTasks } from "./tasks/service";
import { prepareTaskAgent } from "./tasks/agent";
import { TaskFiles } from "../task-files";
import { createTaskTools } from "./tasks/tools";
import { BackgroundReplies } from "./background-replies";
import { createWorkspaceResources, loadWorkspaceSkill } from "./resources";
import {
  loadWorkspaceModels,
  availableBackground,
  requireAvailableModel,
  type WorkspaceModelConfig,
} from "./model-config";
import { readConfigEnvironment } from "../config/files";
import { readApplicationSettings, type ApplicationSettings } from "../config";
import { createWebTools } from "./web-tools";
import {
  createMemoryCurationExtension,
  MemoryCurationService,
} from "./memory-curation";
import { createPikoCodingTools } from "./coding-tools";
import { createSessionSearchTools } from "./session-search-tools";
import { SideChatError, requireSideChat } from "./side-chats";
import { SideChats } from "./side-chat-service";
import { openRuntime } from "./bootstrap";
import { settingsOverview } from "./settings";
import { SettingsConfigurationStore, SettingsValidationError, type SettingsCandidate } from "../settings/configuration";
import type { SaveSettingsConfiguration, SettingsBackgroundModel } from "../../shared/settings";
import type { ModelProfile } from "../config/schema";
import { configureProvider } from "./model-provider";
import type { ProviderConfig } from "../config/model-schema";

/** One owner for storage, scheduler and root-only services; per-chat controllers never close it. */
class PikoRuntime {
  private storage!: Storage;
  sideChats!: SideChats;
  private harness!: Harness;
  private config!: WorkspaceModelConfig;
  private applicationSettings!: ApplicationSettings;
  private env: Record<string, string | undefined> = {};
  private configuredProviderIds = new Set<string>();
  private readonly settingsStore: SettingsConfigurationStore;
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
  ) { this.settingsStore = new SettingsConfigurationStore(paths.home); }

  async init() {
    const settings = (this.applicationSettings = readApplicationSettings(this.paths.home));
    const env = (this.env = readConfigEnvironment(this.paths.home));
    const editor = await this.settingsStore.snapshot();
    this.configuredProviderIds = new Set(Object.keys((JSON.parse(editor.modelDirectory) as { providers: Record<string, unknown> }).providers));
    const config = (this.config = await loadWorkspaceModels({
      home: this.paths.home,
      settings,
      env,
      models: this.models,
    }));
    const coding = await createPikoCodingTools();
    const background = async () => {
      const profile = config.background;
      if (!profile) throw new Error("No background model is selected; choose a main or background model in Settings.");
      return availableBackground(config.models, profile);
    };
    const children = createSubagentRuntime({
      storage: () => this.storage,
      prepareInput: (child, context) => prepareTaskAgent(this.harness, child, new TaskFiles(this.paths.workspace), context),
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
      onReply: (reply) => this.replies.publish(reply),
    });
    const memory = createMemoryCurationExtension({
      workspace: this.paths.workspace,
      bindings: () => this.main?.bindings ?? new Map(),
      background,
      coding,
    });
    const web = createWebTools(env, { settings: settings.tools });
    const sessionSearch = createSessionSearchTools({
      search: async (conversationId, query, limit) =>
        (await this.session(conversationId)).searchHistory(query, limit),
      history: async (conversationId, messageId, limit) =>
        (await this.session(conversationId)).historyAround(messageId, limit),
    });
    this.searchConfigured = web.searchConfigured;
    const registry = createRegistry();
    for (const extension of [
      coding,
      createWorkspaceResources(this.paths),
      web.extension,
      children.extension,
      createSubagentTools(children, background),
      createTaskTools(() => this.tasks),
      memory.extension,
      sessionSearch,
    ])
      registry.install(extension);
    const opened = await openRuntime(this.paths, config, registry);
    this.storage = opened.storage;
    const harness = (this.harness = opened.harness);
    this.sideChats = new SideChats(
      harness,
      this.paths.workspace,
      opened.maintenance,
      (id) => this.session(id),
      async id => {
        const opening = this.sessions.get(id);
        if (opening && (await opening).closed && this.sessions.get(id) === opening) this.sessions.delete(id);
      },
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
        opened.maintenance,
        background,
      );
      this.memory = new MemoryCurationService(
        harness,
        memory.task,
        () => this.main.bindings,
      );
      this.main.attachMemory(this.memory);
      await this.tasks.recoverDeletions();
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
  subagentsService(): AssistantSubagentsRuntime {
    return {
      list: () => this.harness.commit(tx => listDelegations(tx, ROOT_CONVERSATION_ID), ctx),
      status: id => this.harness.commit(tx => delegationStatus(tx, ROOT_CONVERSATION_ID, id), ctx),
    };
  }
  skill(name: string) {
    return loadWorkspaceSkill(this.paths, name);
  }
  async settings() {
    return settingsOverview(await this.main.native.agent(ctx), this.config);
  }
  settingsConfiguration() { return this.settingsStore.snapshot(); }
  private async validateSettingsSelection(selection: import("../../shared/runtime").ModelSelection | null, candidate: SettingsCandidate) {
    if (!selection) return;
    const model = this.config.models.getModel(selection.provider, selection.model);
    if (!model)
      throw new SettingsValidationError("该模型尚未加载；先保存模型目录并重启，再选择它。");
    const provider = candidate.modelDirectory.providers[selection.provider];
    if (!provider && this.configuredProviderIds.has(selection.provider))
      throw new SettingsValidationError(`所选模型供应商 ${selection.provider} 将被移除，请先选择其他模型。`);
    const listed = provider?.models;
    if (listed && !listed.some(item => item.id === selection.model) && !provider?.modelOverrides?.[selection.model])
      throw new SettingsValidationError(`模型目录中不存在 ${selection.provider}/${selection.model}。`);
    const credential = candidate.credentials.find(item => item.providerId === selection.provider);
    const keyless = provider?.keyless === true || !!(model as { keyless?: boolean }).keyless;
    const deleting = candidate.credentialChanges.some(item => item.providerId === selection.provider && item.action === "delete");
    const currentlyAvailable = deleting ? false : (await this.config.models.getAvailable(selection.provider))
      .some(item => item.id === selection.model);
    if (!keyless && !credential?.configured && !currentlyAvailable)
      throw new SettingsValidationError(`供应商 ${selection.provider} 没有可用凭据，不能将其设为前台或后台模型。`);
    const thinking = selection.thinking ?? "off";
    if (!getSupportedThinkingLevels(model).includes(thinking as ModelThinkingLevel))
      throw new SettingsValidationError(`模型 ${selection.provider}/${selection.model} 不支持思考强度 ${thinking}。`);
  }
  async saveSettingsConfiguration(draft: SaveSettingsConfiguration) {
    const saved = await this.settingsStore.save(draft, async candidate => {
      for (const [providerId, raw] of Object.entries(candidate.modelDirectory.providers)) {
        const credential = candidate.credentials.find(item => item.providerId === providerId);
        try {
          configureProvider(providerId, raw as ProviderConfig, this.config.models.getProvider(providerId), this.env,
            credential?.type === "api_key" && credential.configured ? "configuration-validation" : undefined);
        } catch (error) {
          throw new SettingsValidationError(error instanceof Error ? error.message : `供应商 ${providerId} 配置无效。`);
        }
      }
      await this.validateSettingsSelection(candidate.mainModel, candidate);
      await this.validateSettingsSelection(candidate.backgroundModel, candidate);
    });
    let pendingConversations = 0;
    if (!saved.restartRequired) {
      const main = draft.mainModel ? {
        provider: draft.mainModel.provider,
        model: draft.mainModel.model,
        thinking: draft.mainModel.thinking ?? "off",
      } satisfies ModelProfile : undefined;
      const background = draft.backgroundModel ? {
        provider: draft.backgroundModel.provider,
        model: draft.backgroundModel.model,
        thinking: draft.backgroundModel.thinking ?? "off",
      } satisfies ModelProfile : draft.mainModel ? {
        provider: draft.mainModel.provider,
        model: draft.mainModel.model,
        thinking: draft.mainModel.thinking ?? "off",
      } satisfies ModelProfile : undefined;
      this.applicationSettings.agent.profiles.main = main;
      this.applicationSettings.agent.profiles.background = background;
      this.config.main = main;
      this.config.background = background;
      if (main) {
        for (const opening of this.sessions.values()) {
          try {
            const session = await opening;
            if (session.closed) continue;
            await session.syncConfiguredMain();
          } catch {
            pendingConversations++;
          }
        }
      }
    }
    return { snapshot: saved.snapshot, restartRequired: saved.restartRequired, pendingConversations };
  }
  async configureMain(selection: RuntimeSelection) {
    const current = this.config.main;
    const requested = "provider" in selection
      ? selection
      : current && { provider: current.provider, model: current.model, thinking: selection.thinking };
    if (!requested) throw new SettingsValidationError("尚未选择主模型，请从设置中选择模型后再调整思考强度。");
    const model = await requireAvailableModel(this.config.models, requested);
    const thinking = requested.thinking ?? clampThinkingLevel(model, current?.thinking ?? "off");
    const snapshot = await this.settingsStore.snapshot();
    const backgroundModel: SettingsBackgroundModel = this.config.background
      ? { provider: this.config.background.provider, model: this.config.background.model,
          thinking: this.config.background.thinking ?? "off" }
      : null;
    await this.saveSettingsConfiguration({
      baseRevision: snapshot.revision,
      mainModel: { provider: model.provider, model: model.id, thinking },
      backgroundModel,
      modelDirectory: snapshot.modelDirectory,
      credentialOperations: [],
    });
  }
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    this.closed = (async () => {
      this.memory?.close();
      try {
        await this.sideChats?.close();
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
    subagents: async () => (await get()).subagentsService(),
    skill: async name => (await get()).skill(name),
    sideChats: {
      list: async () => (await get()).sideChats.list(),
      create: async (requestId, title) =>
        (await get()).sideChats.create(requestId, title),
      update: async (id, change) => (await get()).sideChats.update(id, change),
      remove: async id => (await get()).sideChats.remove(id),
    },
    isModelReady: async () => (await session()).modelReady(),
    settings: async () => (await get()).settings(),
    settingsConfiguration: async () => (await get()).settingsConfiguration(),
    saveSettingsConfiguration: async draft => (await get()).saveSettingsConfiguration(draft),
    createSession: session,
    describe: async (id) => (await session(id)).describe(),
    configure: async selection => (await get()).configureMain(selection),
    compact: async (id) => (await session(id)).compact(),
    stop: async (commandId, id) => (await session(id)).abort(commandId),
    dispose: () =>
      (closing ??= (async () => {
        if (opening) await (await opening).close();
      })()),
  };
}
