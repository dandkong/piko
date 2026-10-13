import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import {
  createProvider,
  envApiKeyAuth,
  getSupportedThinkingLevels,
  type Api,
  type Model,
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
  readConfigEnvironment,
} from "../config/files.ts";
import { runtimePaths } from "./config/paths.ts";
import {
  object,
  type ModelProfile,
} from "../config/schema.ts";
import { readApplicationSettings } from "../config.ts";
import { EnvironmentCredentialStore } from "./credentials.ts";

const string = Type.String({ minLength: 1 });
const positive = Type.Integer({ minimum: 1 });
const rates = object({
  input: Type.Number({ minimum: 0 }),
  output: Type.Number({ minimum: 0 }),
  cacheRead: Type.Number({ minimum: 0 }),
  cacheWrite: Type.Number({ minimum: 0 }),
});
const headerEnvironment = Type.Record(Type.String(), Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }));
const thinkingMap = object(
  Object.fromEntries(
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [
      level,
      Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ]),
  ),
);
// Options implemented by the OpenAI-compatible adapters. Unknown compatibility keys are rejected.
const compat = object({
  ...Object.fromEntries(
    [
      "supportsStore",
      "supportsDeveloperRole",
      "supportsReasoningEffort",
      "supportsUsageInStreaming",
      "supportsFinishReason",
      "requiresToolResultName",
      "requiresAssistantAfterToolResult",
      "requiresThinkingAsText",
      "requiresReasoningContentOnAssistantMessages",
      "supportsStrictMode",
      "supportsLongCacheRetention",
      "supportsMaxOutputTokens",
      "sendSessionAffinityHeaders",
    ].map((field) => [field, Type.Optional(Type.Boolean())]),
  ),
  maxTokensField: Type.Optional(
    Type.Union([
      Type.Literal("max_completion_tokens"),
      Type.Literal("max_tokens"),
    ]),
  ),
  thinkingFormat: Type.Optional(
    Type.Union(
      (
        [
          "openai",
          "openrouter",
          "together",
          "baseten",
          "deepseek",
          "zai",
          "qwen",
          "chat-template",
          "qwen-chat-template",
          "string-thinking",
          "ant-ling",
        ] as const
      ).map((value) => Type.Literal(value)),
    ),
  ),
  sessionAffinityFormat: Type.Optional(
    Type.Union(
      (["openai", "openai-nosession", "openrouter"] as const).map((value) =>
        Type.Literal(value),
      ),
    ),
  ),
});
const request = object({
  temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
  maxTokens: Type.Optional(positive),
});
const modelFields = {
  name: Type.Optional(string),
  api: Type.Optional(string),
  baseUrl: Type.Optional(string),
  reasoning: Type.Optional(Type.Boolean()),
  thinkingLevelMap: Type.Optional(thinkingMap),
  input: Type.Optional(
    Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), {
      minItems: 1,
    }),
  ),
  cost: Type.Optional(rates),
  contextWindow: Type.Optional(positive),
  maxTokens: Type.Optional(positive),
  samplingParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  headersEnv: Type.Optional(headerEnvironment),
  compat: Type.Optional(compat),
  request: Type.Optional(request),
};
const modelSchema = object({ id: string, ...modelFields });
const overrideSchema = object(modelFields);
const providerSchema = object({
  name: Type.Optional(string),
  baseUrl: Type.Optional(string),
  api: Type.Optional(string),
  keyless: Type.Optional(Type.Boolean()),
  headersEnv: Type.Optional(headerEnvironment),
  compat: Type.Optional(compat),
  request: Type.Optional(request),
  models: Type.Optional(Type.Array(modelSchema)),
  modelOverrides: Type.Optional(Type.Record(Type.String(), overrideSchema)),
});
const modelsSchema = object({
  providers: Type.Record(Type.String(), providerSchema),
});
type ProviderConfig = Static<typeof providerSchema>;
type ModelConfig = Static<typeof overrideSchema>;

export type WorkspaceModelConfig = {
  models: Models;
  profiles: Record<string, ModelProfile>;
  defaultModel?: ModelProfile;
  harnessSettings: Pick<HarnessSettings, "stream">;
};

export async function loadWorkspaceModels(
  home: string,
  injected?: Models,
): Promise<WorkspaceModelConfig> {
  const paths = runtimePaths(home);
  const env = readConfigEnvironment(home);
  const agent = readApplicationSettings(home).agent;
  const config = readJson(join(paths.config, "models.json"), modelsSchema, {
    providers: {},
  });
  const builtins = injected
    ? undefined
    : builtinModels({
        credentials: new EnvironmentCredentialStore(home, env),
        authContext: {
          env: async (name) => env[name],
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
        configureProvider(id, provider, models.getProvider(id), env),
      );
  }
  const profiles = agent.profiles as Record<string, ModelProfile>;
  for (const [name, profile] of Object.entries(profiles)) {
    const model = models.getModel(profile.provider, profile.model);
    if (!model)
      throw new Error(
        `Profile ${name}: unknown model ${profile.provider}/${profile.model}`,
      );
    if (!getSupportedThinkingLevels(model).includes(profile.thinking ?? "off"))
      throw new Error(
        `Profile ${name}: unsupported thinking level ${profile.thinking}`,
      );
  }
  const defaultModel = agent.defaultProfile
    ? profiles[agent.defaultProfile]
    : undefined;
  if (defaultModel) await requireAvailableModel(models, defaultModel);
  return {
    models,
    profiles,
    defaultModel,
    harnessSettings: {
      stream: agent.stream as HarnessSettings["stream"],
    },
  };
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
      `Model ${profile.provider}/${profile.model} is unavailable. Check backend credential environment variables or config/.env.`,
    );
  return model;
}

function configureProvider(
  id: string,
  config: ProviderConfig,
  builtin: Provider | undefined,
  env: Record<string, string | undefined>,
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
  const auth = config.keyless
    ? {
        apiKey: { name: "Local endpoint", resolve: async () => ({ auth: {} }) },
      }
    : (builtin?.auth ?? {
        apiKey: envApiKeyAuth(`${id} API key`, [
          `${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`,
        ]),
      });
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
