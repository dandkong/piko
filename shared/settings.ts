import type { ModelSelection, RuntimeDescription } from "./runtime";

/** Safe projection and editable configuration snapshot; never return raw credentials or arbitrary environment values. */
export type SettingsBackgroundModel =
  | { mode: "follow-main" }
  | { mode: "model"; selection: ModelSelection };

export type SettingsCredentialState = {
  providerId: string;
  configured: boolean;
  type: "api_key" | "oauth" | null;
  sources: ("auth.json" | "models.json")[];
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
  mode: "configuration";
  app: { name: "Piko"; version: string; runtime: "pi-durable" };
  currentModel: ModelSelection | null;
  mainModel: ModelSelection | null;
  backgroundModel: SettingsBackgroundModel;
  availableModels: RuntimeDescription["models"];
  tools: {
    search: { enabled: boolean; providers: { id: string; configured: boolean }[] };
    extract: { enabled: boolean; providers: string[] };
  };
  skills: { name: string; description: string; modelInvocable: boolean }[];
  telegram: { enabled: boolean; credentialConfigured: boolean };
  workspace: { path: string; artifactsPath: string };
  memory: { idleMinutes: number; minimumUserMessages: number };
  modelReady: boolean;
};
