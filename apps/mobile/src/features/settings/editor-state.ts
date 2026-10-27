import type { ModelSelection } from "../../../../../shared/runtime";
import type { SettingsBackgroundModel, SettingsConfigurationSnapshot } from "../../../../../shared/settings";

export type SettingsEditorDraft = {
  mainModel: ModelSelection | null;
  backgroundModel: SettingsBackgroundModel;
  modelDirectory: string;
  keyInputs: Record<string, string>;
  deleteProviders: string[];
};

export function settingsDraft(snapshot: SettingsConfigurationSnapshot): SettingsEditorDraft {
  return {
    mainModel: snapshot.mainModel,
    backgroundModel: snapshot.backgroundModel,
    modelDirectory: snapshot.modelDirectory,
    keyInputs: {},
    deleteProviders: [],
  };
}
