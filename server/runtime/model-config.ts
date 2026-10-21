import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createProvider,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
  type Models,
  type Provider,
  type ProviderStreams,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import type { HarnessSettings } from "@earendil-works/pi-durable";
import {
  readJson,
} from "../config/files.ts";
import { runtimePaths } from "./config/paths.ts";
import { type ModelProfile } from "../config/schema.ts";
import type { ApplicationSettings } from "../config.ts";
import { modelsSchema, type ModelConfig, type ProviderConfig } from "../config/model-schema.ts";
import { StoredCredentialStore } from "./credentials.ts";
import type { BackgroundSelection } from "./background";

export type WorkspaceModelConfig = {
  models: Models;
  /** Initial selection for a new main conversation, or one that never stored a model. */
  main?: ModelProfile;
  /** Model for delegation, scheduled runs and memory review. */
  background?: ModelProfile;
  harnessSettings: Pick<HarnessSettings, "stream">;
};

export type ModelConfigInput = {
  home: string;
  settings: ApplicationSettings;
  env: Record<string, string | undefined>;
  /** Replaces the Pi catalog; used by ad-hoc verification scripts. */
  models?: Models;
};

export async function loadWorkspaceModels({ home, settings, env, models: injected }: ModelConfigInput): Promise<WorkspaceModelConfig> {
  const paths = runtimePaths(home);
  const agent = settings.agent;
  const config = readJson(join(paths.config, "models.json"), modelsSchema, {
    providers: {},
  });
  const credentials = new StoredCredentialStore(join(paths.config, "auth.json"));
  const builtins = injected
    ? undefined
    : builtinModels({
        credentials,
        // Model credentials live in config/auth.json and models.json only, never in the process env.
        authContext: {
          env: async () => undefined,
          fileExists: async (path) =>
            existsSync(
              path.startsWith("~/") ? join(homedir(), path.slice(2)) : path,
            ),
        },
      });
  const models = injected ?? builtins!;
  if (!injected) {
    for (const [id, provider] of Object.entries(config.providers))
      builtins!.setProvider(
        configureProvider(id, provider, models.getProvider(id), env, credentials.apiKey(id)),
      );
  }
  const main = agent.profiles.main;
  const background = agent.profiles.background;
  for (const [role, profile] of [["main", main], ["background", background]] as const) {
    if (!profile) continue;
    const model = models.getModel(profile.provider, profile.model);
    if (!model)
      throw new Error(
        `Profile ${role}: unknown model ${profile.provider}/${profile.model}`,
      );
    if (!getSupportedThinkingLevels(model).includes(profile.thinking ?? "off"))
      throw new Error(
        `Profile ${role}: unsupported thinking level ${profile.thinking}`,
      );
  }
  if (main) await requireAvailableModel(models, main);
  return {
    models,
    main,
    background,
    harnessSettings: {
      stream: agent.stream as HarnessSettings["stream"],
    },
  };
}

function select(profile: ModelProfile): BackgroundSelection {
  return {
    provider: profile.provider,
    modelId: profile.model,
    thinkingLevel: (profile.thinking ?? "off") as ModelThinkingLevel,
  };
}

/** Startup applies the configured model to stored children without touching credentials. */
export function configuredBackground(profile: ModelProfile | undefined): BackgroundSelection | undefined {
  return profile && select(profile);
}

/** Spawn fails a background job, not startup, when its provider has no usable credentials. */
export async function availableBackground(models: Models, profile: ModelProfile | undefined): Promise<BackgroundSelection | undefined> {
  if (!profile) return undefined;
  try {
    const model = await requireAvailableModel(models, profile);
    return { provider: model.provider, modelId: model.id, thinkingLevel: (profile.thinking ?? "off") as ModelThinkingLevel };
  } catch (error) {
    throw new Error(`Background: ${error instanceof Error ? error.message : "model unavailable"}`);
  }
}

export async function requireAvailableModel(
  models: Models,
  profile: ModelProfile,
): Promise<Model<Api>> {
  const model = (await models.getAvailable(profile.provider)).find(
    (model) => model.id === profile.model,
  );
  if (!model)
    throw new Error(
      `Model ${profile.provider}/${profile.model} is unavailable. Add its key to config/auth.json or models.json providers.`,
    );
  return model;
}

function configureProvider(
  id: string,
  config: ProviderConfig,
  builtin: Provider | undefined,
  env: Record<string, string | undefined>,
  storedKey?: string,
): Provider {
  const location = `models.json providers.${id}`;
  const resolveHeaders = (values?: Record<string, string>) => values && Object.fromEntries(
    Object.entries(values).map(([key, name]) => {
      const value = env[name];
      if (!value) throw new Error(`Missing environment variable ${name}, referenced by ${location}.headersEnv`);
      return [key, value];
    }),
  );
  const catalog = new Map(
    (builtin?.getModels() ?? []).map((model) => [model.id, model]),
  );
  const requests = new Map<string, SimpleStreamOptions>();
  const decorate = (
    modelId: string,
    original: Model<Api> | undefined,
    value: ModelConfig,
  ): Model<Api> => {
    const { request: requestOptions, headersEnv, ...fields } = value;
    const api = fields.api ?? config.api ?? original?.api;
    const baseUrl = fields.baseUrl ?? config.baseUrl ?? original?.baseUrl;
    const contextWindow = fields.contextWindow ?? original?.contextWindow;
    const maxTokens = fields.maxTokens ?? original?.maxTokens;
    if (!api || (!baseUrl && !original) || !contextWindow || !maxTokens)
      throw new Error(
        `${location} model ${modelId}: api, baseUrl, contextWindow and maxTokens are required for new models`,
      );
    if (!original || fields.baseUrl || config.baseUrl) {
      try {
        const url = new URL(baseUrl!);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      } catch {
        throw new Error(
          `${location} model ${modelId}: baseUrl must be an HTTP or HTTPS URL`,
        );
      }
    }
    if (requestOptions?.maxTokens && requestOptions.maxTokens > maxTokens)
      throw new Error(
        `${location} model ${modelId}: request.maxTokens exceeds the model maxTokens`,
      );
    requests.set(modelId, { ...config.request, ...requestOptions });
    return {
      name: modelId,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...original,
      ...fields,
      id: modelId,
      provider: id,
      api: api as Api,
      baseUrl,
      contextWindow,
      maxTokens,
      headers: {
        ...original?.headers,
        ...resolveHeaders(config.headersEnv),
        ...resolveHeaders(headersEnv),
      },
      compat: { ...original?.compat, ...config.compat, ...fields.compat },
      thinkingLevelMap: {
        ...original?.thinkingLevelMap,
        ...fields.thinkingLevelMap,
      },
      samplingParams: { ...original?.samplingParams, ...fields.samplingParams },
    } as Model<Api>;
  };
  for (const [modelId, model] of catalog)
    catalog.set(modelId, decorate(modelId, model, {}));
  const declared = new Set<string>();
  for (const { id: modelId, ...value } of config.models ?? []) {
    if (declared.has(modelId))
      throw new Error(`${location}: duplicate model ${modelId}`);
    declared.add(modelId);
    catalog.set(modelId, decorate(modelId, catalog.get(modelId), value));
  }
  for (const [modelId, value] of Object.entries(config.modelOverrides ?? {})) {
    if (!catalog.has(modelId))
      throw new Error(`${location}.modelOverrides: unknown model ${modelId}`);
    const inherited = requests.get(modelId);
    catalog.set(
      modelId,
      decorate(modelId, catalog.get(modelId), {
        ...value,
        request: { ...inherited, ...value.request },
      }),
    );
  }
  if (!catalog.size) throw new Error(`${location}: no models configured`);
  for (const model of catalog.values()) {
    const max = requests.get(model.id)?.maxTokens;
    if (max && max > model.maxTokens)
      throw new Error(
        `${location} model ${model.id}: request.maxTokens exceeds the model maxTokens`,
      );
  }
  if (config.keyless && config.apiKey)
    throw new Error(
      `${location}: choose either keyless or apiKey, not both`,
    );
  const auth = config.keyless
    ? {
        apiKey: { name: "Local endpoint", resolve: async () => ({ auth: {} }) },
      }
    : storedKey
      ? {
          apiKey: {
            name: `${id} stored API key`,
            resolve: async () => ({ auth: { apiKey: storedKey } }),
          },
        }
      : config.apiKey
        ? {
            apiKey: {
              name: `${id} API key`,
              resolve: async () => ({ auth: { apiKey: config.apiKey } }),
            },
          }
        : { apiKey: { name: `${id} API key`, resolve: async () => undefined } };
  const configuredHeaders = {
    ...builtin?.headers,
    ...resolveHeaders(config.headersEnv),
  };
  let base: Provider;
  if (
    builtin &&
    !config.api &&
    !(config.models ?? []).some(
      (model) =>
        model.api &&
        !builtin.getModels().some((known) => known.api === model.api),
    ) &&
    !Object.values(config.modelOverrides ?? {}).some((model) => model.api)
  ) {
    base = {
      ...builtin,
      name: config.name ?? builtin.name,
      baseUrl: config.baseUrl ?? builtin.baseUrl,
      headers: configuredHeaders,
      auth,
      getModels: () => [...catalog.values()],
      getAllModels: undefined,
      refreshModels: undefined,
    };
  } else {
    const adapters: Record<string, ProviderStreams> = {};
    for (const model of catalog.values()) {
      if (adapters[model.api]) continue;
      switch (model.api) {
        case "openai-completions":
          adapters[model.api] = openAICompletionsApi();
          break;
        case "openai-responses":
          adapters[model.api] = openAIResponsesApi();
          break;
        case "anthropic-messages":
          adapters[model.api] = anthropicMessagesApi();
          break;
        default:
          throw new Error(
            `${location}: custom api ${model.api} is unsupported`,
          );
      }
    }
    base = createProvider({
      id,
      name: config.name,
      baseUrl: config.baseUrl,
      headers: configuredHeaders,
      auth,
      models: [...catalog.values()],
      api: adapters,
    });
  }
  const options = <T extends { maxTokens?: number; temperature?: number }>(
    model: Model<Api>,
    supplied?: T,
  ): T => {
    const defaults = requests.get(model.id);
    // Compaction supplies its own output budget. Respect that explicit cap.
    const result = { ...defaults, ...supplied };
    if (result.maxTokens !== undefined)
      result.maxTokens = Math.min(result.maxTokens, model.maxTokens);
    return result as T;
  };
  return {
    ...base,
    stream: (model, context, supplied) =>
      base.stream(model, context, options(model, supplied)),
    streamSimple: (model, context, supplied) =>
      base.streamSimple(model, context, options(model, supplied)),
  };
}
