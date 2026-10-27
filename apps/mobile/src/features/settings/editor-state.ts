import type { ModelSelection } from "../../../../../shared/runtime";
import type { SettingsBackgroundModel, SettingsConfigurationSnapshot } from "../../../../../shared/settings";

export type SettingsEditorDraft = {
  mainModel: ModelSelection | null;
  backgroundModel: SettingsBackgroundModel;
  keyInputs: Record<string, string>;
};

export function settingsDraft(snapshot: SettingsConfigurationSnapshot): SettingsEditorDraft {
  return {
    mainModel: snapshot.mainModel,
    backgroundModel: snapshot.backgroundModel,
    keyInputs: Object.fromEntries(snapshot.credentials.flatMap(credential => credential.apiKey
      ? [[credential.providerId, credential.apiKey] as const]
      : [])),
  };
}

export function settingsChangedCredentialIds(snapshot: SettingsConfigurationSnapshot, draft: SettingsEditorDraft) {
  const ids = new Set([
    ...snapshot.credentials.filter(credential => credential.apiKey).map(credential => credential.providerId),
    ...Object.keys(draft.keyInputs),
  ]);
  return [...ids].filter(providerId => {
    const original = snapshot.credentials.find(credential => credential.providerId === providerId)?.apiKey ?? "";
    return (draft.keyInputs[providerId] ?? original).trim() !== original.trim();
  });
}

export function settingsDraftHasChanges(snapshot: SettingsConfigurationSnapshot, draft: SettingsEditorDraft) {
  return settingsModelDraftHasChanges(snapshot, draft) || settingsCredentialDraftHasChanges(snapshot, draft);
}

export function settingsModelDraftHasChanges(snapshot: SettingsConfigurationSnapshot, draft: SettingsEditorDraft) {
  return JSON.stringify(draft.mainModel) !== JSON.stringify(snapshot.mainModel) ||
    JSON.stringify(draft.backgroundModel) !== JSON.stringify(snapshot.backgroundModel);
}

export function settingsCredentialDraftHasChanges(snapshot: SettingsConfigurationSnapshot, draft: SettingsEditorDraft) {
  return settingsChangedCredentialIds(snapshot, draft).length > 0;
}

export function settingsDraftRequiresRestart(snapshot: SettingsConfigurationSnapshot, draft: SettingsEditorDraft) {
  return settingsChangedCredentialIds(snapshot, draft).length > 0;
}
