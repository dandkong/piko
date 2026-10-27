import type { ModelSelection, RuntimeDescription } from "./runtime";

export const SETTINGS_CREDENTIAL_PROVIDERS = [
  { id: "deepseek", label: "DeepSeek" },
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "google", label: "Google Gemini" },
] as const;

/** Settings configuration snapshot; API keys are returned only here for masked editing/reveal in Settings. */
export type SettingsBackgroundModel = ModelSelection | null;

export type SettingsCredentialState = {
  providerId: string;
  configured: boolean;
  type: "api_key" | "oauth" | null;
  sources: ("auth.json" | "models.json")[];
  apiKey?: string;
};

export type SettingsConfigurationSnapshot = {
  revision: string;
  mainModel: ModelSelection | null;
  backgroundModel: SettingsBackgroundModel;
  /** JSON of the non-secret models.json model directory; credentials are never included. */
  modelDirectory: string;
  credentials: SettingsCredentialState[];
};

export type SettingsCredentialOperation =
  | { providerId: string; action: "set"; key: string }
  | { providerId: string; action: "delete" };

export type SaveSettingsConfiguration = {
  baseRevision: string;
  mainModel: ModelSelection | null;
  backgroundModel: SettingsBackgroundModel;
  modelDirectory: string;
  credentialOperations: SettingsCredentialOperation[];
};

export type SaveSettingsResult = {
  snapshot: SettingsConfigurationSnapshot;
  restartRequired: boolean;
  pendingConversations: number;
};

export type SettingsOverview = {
  mainModel: ModelSelection | null;
  currentModel: ModelSelection | null;
  availableModels: RuntimeDescription["models"];
};
