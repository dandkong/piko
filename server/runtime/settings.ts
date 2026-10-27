import { join } from "node:path";
import type { Agent } from "@earendil-works/pi-durable";
import type { ApplicationSettings } from "../config";
import type { WorkspacePaths } from "../workspace";
import type { ModelSelection } from "../../shared/runtime";
import type { SettingsOverview } from "../../shared/settings";
import { version } from "../../package.json";
import { MEMORY_CURATION_IDLE_MS, MEMORY_CURATION_MIN_USER_MESSAGES } from "./memory-curation";
import { NO_AGENT_RESOURCES } from "./agents/resources";
import { loadWorkspaceResources } from "./resources";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { WorkspaceModelConfig } from "./model-config";

/** Captures only an allowlist of safe startup facts, not a credential-bearing config snapshot. */
export function settingsDefaults(paths: WorkspacePaths, settings: ApplicationSettings,
  env: Record<string, string | undefined>, tools: SettingsOverview["tools"]) {
  const configured = (key: string) => !!env[key]?.trim();
  const profile = (value: ModelSelection | undefined): ModelSelection | null => value
    ? { provider: value.provider, model: value.model, thinking: value.thinking ?? "off" } : null;
  return {
    mode: "read-only" as const,
    app: { name: "Piko" as const, version, runtime: "pi-durable" as const },
    defaults: { main: profile(settings.agent.profiles.main), background: profile(settings.agent.profiles.background) },
    tools,
    telegram: { enabled: settings.channels.telegram.enabled, credentialConfigured: configured("PIKO_TELEGRAM_BOT_TOKEN") },
    workspace: { path: paths.workspace, artifactsPath: join(paths.workspace, "artifacts") },
    memory: { idleMinutes: MEMORY_CURATION_IDLE_MS / 60_000, minimumUserMessages: MEMORY_CURATION_MIN_USER_MESSAGES },
  };
}

/** Current selection and catalog are native/runtime facts; skill bodies and paths never enter this DTO. */
export async function settingsOverview(base: ReturnType<typeof settingsDefaults>, agent: Agent,
  config: WorkspaceModelConfig, paths: WorkspacePaths): Promise<SettingsOverview> {
  const models = await config.models.getAvailable();
  const resources = await loadWorkspaceResources(paths, undefined, { policy: { ...NO_AGENT_RESOURCES, skills: "workspace" } });
  return {
    ...base,
    currentModel: agent.model ? { provider: agent.model.provider, model: agent.model.modelId, thinking: agent.thinkingLevel } : null,
    availableModels: models.map(model => ({
      provider: model.provider, id: model.id, name: model.name, imageInput: model.input.includes("image"),
      contextWindow: model.contextWindow, thinkingLevels: getSupportedThinkingLevels(model),
    })),
    skills: resources.skills.map(skill => ({ name: skill.name, description: skill.description, modelInvocable: !skill.disableModelInvocation })),
    modelReady: models.length > 0,
  };
}
