import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Keyboard, Modal, StyleSheet, Text, View } from "react-native";
import { FloatingPanel } from "../../components/FloatingPanel";
import { TextButton } from "../../components/TextButton";
import { ConfirmationDialogContent } from "../../components/ConfirmationDialog";
import { colors, radii } from "../../theme";
import { SettingsModelsEditor } from "./SettingsModelsEditor";
import { useSettings } from "./useSettings";
import { loadSettingsConfiguration, saveSettingsConfiguration } from "./api";
import { useDismissOnBack } from "../../hooks/useDismissOnBack";
import {
  settingsDraft,
  settingsCredentialDraftHasChanges,
  settingsModelDraftHasChanges,
  settingsDraftRequiresRestart,
  settingsChangedCredentialIds,
  type SettingsEditorDraft,
} from "./editor-state";
import type { SettingsPage } from "./SettingsModelsEditor";
import { SettingsDetailPage } from "./SettingsDetailPage";
import type { SettingsConfigurationSnapshot, SettingsCredentialOperation } from "../../../../../shared/settings";

/** Settings form and configuration APIs are intentionally unauthenticated during initial functional validation. */
export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, loading, error, refresh } = useSettings(open);
  const [configuration, setConfiguration] = useState<SettingsConfigurationSnapshot>();
  const [draft, setDraft] = useState<SettingsEditorDraft>();
  const [configurationLoading, setConfigurationLoading] = useState(false);
  const [configurationError, setConfigurationError] = useState("");
  const [saving, setSaving] = useState(false);
  const [applyingModel, setApplyingModel] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const [restartPrompt, setRestartPrompt] = useState(false);
  const [page, setPage] = useState<SettingsPage>("home");
  const configRequest = useRef<AbortController | undefined>(undefined);
  const savingRef = useRef(false);
  const applyingModelRef = useRef(false);
  const clearSensitiveDraft = useCallback(() => {
    setConfiguration(undefined);
    setDraft(undefined);
    setConfigurationError("");
    setApplyingModel(false);
    applyingModelRef.current = false;
    setSaveStatus("");
    setDiscardPrompt(false);
    setRestartPrompt(false);
    setPage("home");
  }, []);
  const updateCredentialDraft = useCallback((value: SettingsEditorDraft) => {
    setDraft(value);
    setSaveStatus("");
  }, []);

  useDismissOnBack(open && !discardPrompt && !restartPrompt, () => {
    if (page !== "home") setPage("home");
  });

  const credentialDirty = useMemo(() => {
    if (!configuration || !draft) return false;
    return settingsCredentialDraftHasChanges(configuration, draft);
  }, [configuration, draft]);

  const refreshConfiguration = useCallback(async () => {
    configRequest.current?.abort();
    const controller = new AbortController();
    configRequest.current = controller;
    setConfigurationLoading(true);
    setConfigurationError("");
    try {
      const result = await loadSettingsConfiguration(controller.signal);
      if (configRequest.current !== controller || controller.signal.aborted) return;
      setConfiguration(result);
      setDraft(settingsDraft(result));
      setSaveStatus("");
    } catch (cause) {
      if (configRequest.current !== controller || controller.signal.aborted) return;
      setConfigurationError(cause instanceof Error ? cause.message : "无法读取可编辑配置，请重试。");
    } finally {
      if (configRequest.current === controller) {
        configRequest.current = undefined;
        setConfigurationLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (open) {
      setPage("home");
      void refreshConfiguration();
    }
    else {
      configRequest.current?.abort();
      clearSensitiveDraft();
    }
  }, [open, refreshConfiguration, clearSensitiveDraft]);

  const applyModelDraft = useCallback(async (value: SettingsEditorDraft) => {
    if (!configuration || !draft || savingRef.current || applyingModelRef.current) return;
    if (!settingsModelDraftHasChanges(configuration, value)) {
      setDraft(value);
      return;
    }
    const mainModelChanged = JSON.stringify(value.mainModel) !== JSON.stringify(configuration.mainModel);
    applyingModelRef.current = true;
    setApplyingModel(true);
    setDraft(value);
    setConfigurationError("");
    setSaveStatus("");
    try {
      const result = await saveSettingsConfiguration({
        baseRevision: configuration.revision,
        mainModel: value.mainModel,
        backgroundModel: value.backgroundModel,
        modelDirectory: configuration.modelDirectory,
        credentialOperations: [],
      });
      setConfiguration(result.snapshot);
      setDraft(current => ({ ...settingsDraft(result.snapshot), keyInputs: current?.keyInputs ?? value.keyInputs }));
      if (mainModelChanged) void refresh();
      if (mainModelChanged && result.pendingConversations) {
        setSaveStatus(`主模型已应用；${result.pendingConversations} 个忙碌会话将在下一轮对齐。`);
      }
    } catch (cause) {
      setConfigurationError(cause instanceof Error ? cause.message : "应用模型设置失败，请重试。");
      setDraft(current => current ? {
        ...current,
        mainModel: configuration.mainModel,
        backgroundModel: configuration.backgroundModel,
      } : current);
    } finally {
      applyingModelRef.current = false;
      setApplyingModel(false);
    }
  }, [configuration, draft, refresh]);

  const saveCredentials = useCallback(async (value: SettingsEditorDraft) => {
    if (!configuration || savingRef.current || applyingModelRef.current) return;
    savingRef.current = true;
    Keyboard.dismiss();
    setSaving(true);
    setConfigurationError("");
    setSaveStatus("");
    const credentialOperations: SettingsCredentialOperation[] = [];
    for (const providerId of settingsChangedCredentialIds(configuration, value)) {
      const key = value.keyInputs[providerId] ?? "";
      credentialOperations.push(key.trim()
        ? { providerId, action: "set", key }
        : { providerId, action: "delete" });
    }
    try {
      const result = await saveSettingsConfiguration({
        baseRevision: configuration.revision,
        mainModel: value.mainModel,
        backgroundModel: value.backgroundModel,
        modelDirectory: configuration.modelDirectory,
        credentialOperations,
      });
      setConfiguration(result.snapshot);
      setDraft(settingsDraft(result.snapshot));
      await refresh();
      if (result.restartRequired) {
        setSaveStatus(result.restartScheduled
          ? "配置已保存，Piko 正在重启。稍候刷新页面即可继续。"
          : "配置已保存；需要重启 Piko 后生效。");
        if (result.restartScheduled) {
          for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            try {
              const current = await loadSettingsConfiguration();
              setConfiguration(current);
              setDraft(settingsDraft(current));
              setConfigurationError("");
              setSaveStatus("配置已应用，Piko 已重新启动。");
              await refresh();
              break;
            } catch { /* expected while the service is restarting */ }
          }
        }
      } else if (result.pendingConversations) {
        setSaveStatus(`主模型已应用；${result.pendingConversations} 个忙碌会话将在下一轮对齐。`);
      }
    } catch (cause) {
      setConfigurationError(cause instanceof Error ? cause.message : "保存设置失败，请重试。");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [configuration, refresh]);

  const handleClose = () => {
    if (savingRef.current || applyingModelRef.current) return;
    if (credentialDirty) { setDiscardPrompt(true); return; }
    clearSensitiveDraft();
    onClose();
  };

  const renderEditor = (targetPage: SettingsPage) => data ? <SettingsModelsEditor
    page={targetPage}
    overview={data}
    snapshot={configuration}
    draft={draft}
    loading={configurationLoading}
    saving={saving || applyingModel}
    error={configurationError}
    status={saveStatus}
    onModelChange={applyModelDraft}
    onCredentialChange={updateCredentialDraft}
    onNavigate={setPage}
    onRetry={() => void refreshConfiguration()}
  /> : undefined;
  const homeEditor = renderEditor("home");
  const detailEditor = page === "home" ? undefined : renderEditor(page);
  const title = page === "main-model" ? "主模型"
    : page === "background-model" ? "后台模型"
      : page === "credentials" ? "供应商凭据" : "设置";
  const needsRestart = !!configuration && !!draft && settingsDraftRequiresRestart(configuration, draft);
  const saveFooter = configuration && draft && credentialDirty ? <SettingsSaveFooter
    draft={draft}
    dirty={credentialDirty}
    restartRequired={needsRestart}
    saving={saving || applyingModel}
    loading={configurationLoading}
    confirmRestart={restartPrompt}
    setConfirmRestart={setRestartPrompt}
    onSave={value => void saveCredentials(value)}
  /> : undefined;
  const homeFooter = page === "home" ? saveFooter : undefined;
  const detailOverlay = page !== "home" ? <SettingsDetailPage title={title} onBack={() => setPage("home")}
    footer={saveFooter} contentKey={page} testID="settings-detail-page">
    {detailEditor}
  </SettingsDetailPage> : undefined;

  return <>
    <FloatingPanel
      closeLabel="关闭设置"
      closeDisabled={saving || applyingModel}
      onClose={handleClose}
      open={open}
      testID="settings-sheet"
      title="设置"
      footer={homeFooter}
      overlay={detailOverlay}
    >
      {open && loading && (
        <View style={styles.loading} accessibilityLiveRegion="polite">
          <ActivityIndicator accessibilityLabel={data ? "正在刷新设置" : "正在读取设置"} color={colors.muted} size="small" />
          <Text style={styles.note}>{data ? "正在刷新…" : "正在读取设置…"}</Text>
        </View>
      )}
      {open && !!error && (
        <View style={styles.notice}>
          <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
          <TextButton label="重试读取设置" onPress={() => void refresh()} disabled={loading}>
            <Text style={styles.retry}>重试</Text>
          </TextButton>
        </View>
      )}
      {open ? homeEditor : null}
    </FloatingPanel>
    <Modal transparent visible={discardPrompt} animationType="fade" onRequestClose={() => setDiscardPrompt(false)}>
      {discardPrompt ? <ConfirmationDialogContent title="放弃未保存的设置？"
        message="未保存的凭据修改将被丢弃。"
        onCancel={() => setDiscardPrompt(false)} onConfirm={() => { clearSensitiveDraft(); onClose(); }}
        confirmLabel="放弃修改" cancelLabel="继续编辑" /> : null}
    </Modal>
  </>;
}

function SettingsSaveFooter({ draft, dirty, restartRequired, saving, loading, confirmRestart, setConfirmRestart, onSave }: {
  draft: SettingsEditorDraft;
  dirty: boolean;
  restartRequired: boolean;
  saving: boolean;
  loading: boolean;
  confirmRestart: boolean;
  setConfirmRestart: (confirm: boolean) => void;
  onSave: (draft: SettingsEditorDraft) => void;
}) {
  return <>
    <View style={styles.footerContent}>
      {restartRequired && dirty ? <Text style={styles.note}>保存凭据需重启服务。</Text> : null}
      <TextButton label={restartRequired ? "保存并重启 Piko" : "保存并应用设置"}
        disabled={!dirty || saving || loading}
        accessibilityState={{ busy: saving }}
        onPress={() => restartRequired ? setConfirmRestart(true) : onSave(draft)}
        variant="primary" faceStyle={styles.saveButton}>
        <Text style={styles.saveText}>{saving ? "保存中…" : restartRequired ? "保存并重启" : "保存并应用"}</Text>
      </TextButton>
    </View>
    <Modal transparent visible={confirmRestart} animationType="fade" onRequestClose={() => setConfirmRestart(false)}>
      {confirmRestart ? <ConfirmationDialogContent title="这次保存需要重启 Piko"
        message="重启可能中断正在运行的工作；不确定的执行不会自动重放。"
        onCancel={() => setConfirmRestart(false)} onConfirm={() => { setConfirmRestart(false); onSave(draft); }}
        confirmLabel="保存并重启" cancelLabel="取消" /> : null}
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  loading: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 20, paddingVertical: 12 },
  note: { color: colors.muted, fontSize: 12, lineHeight: 19 },
  notice: { marginHorizontal: 20, marginBottom: 16, gap: 10, alignItems: "flex-start" },
  error: { color: colors.danger, fontSize: 14, lineHeight: 21 },
  retry: { color: colors.text, fontSize: 14, fontWeight: "500" },
  footerContent: { gap: 8 },
  saveButton: { minHeight: 48, borderRadius: radii.control },
  saveText: { color: colors.text, fontSize: 14, fontWeight: "600" },
});
