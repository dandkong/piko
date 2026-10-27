import type { ModelSelection, RuntimeDescription } from "./runtime";

/** Explicit read-only projection. Never add raw config, credentials or arbitrary environment values. */
export type SettingsOverview = {
  mode: "read-only";
  app: { name: "Piko"; version: string; runtime: "pi-durable" };
  currentModel: ModelSelection | null;
  defaults: { main: ModelSelection | null; background: ModelSelection | null };
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
