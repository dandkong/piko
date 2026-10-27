import type { Agent } from "@earendil-works/pi-durable";
import type { SettingsOverview } from "../../shared/settings";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { WorkspaceModelConfig } from "./model-config";

/** Only return the model data needed by the editable model configuration form. */
export async function settingsOverview(agent: Agent, config: WorkspaceModelConfig): Promise<SettingsOverview> {
  const models = await config.models.getAvailable();
  return {
    mainModel: config.main ? { provider: config.main.provider, model: config.main.model, thinking: config.main.thinking ?? "off" } : null,
    currentModel: agent.model ? { provider: agent.model.provider, model: agent.model.modelId, thinking: agent.thinkingLevel } : null,
    availableModels: models.map(model => ({
      provider: model.provider, id: model.id, name: model.name, imageInput: model.input.includes("image"),
      contextWindow: model.contextWindow, thinkingLevels: getSupportedThinkingLevels(model),
    })),
  };
}
