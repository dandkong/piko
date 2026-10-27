import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, StyleSheet, Text, View } from "react-native";
import { ArrowLeft, RefreshCw } from "lucide-react-native";
import { FloatingPanel } from "../../components/FloatingPanel";
import { IconButton } from "../../components/IconButton";
import { TextButton } from "../../components/TextButton";
import { ConfirmationDialogContent } from "../../components/ConfirmationDialog";
import { colors } from "../../theme";
import { SettingsContent, settingsTitles, type SettingsPage } from "./SettingsContent";
import { SettingsModelsEditor } from "./SettingsModelsEditor";
import { useSettings } from "./useSettings";
import { loadSettingsConfiguration, saveSettingsConfiguration } from "./api";
import { settingsDraft, type SettingsEditorDraft } from "./editor-state";
import type { SettingsConfigurationSnapshot, SettingsCredentialOperation } from "../../../../../shared/settings";

/** Settings form and configuration APIs are intentionally unauthenticated during initial functional validation. */
export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [page, setPage] = useState<SettingsPage>("overview");
  const { data, loading, error, refresh } = useSettings(open);
  const [configuration, setConfiguration] = useState<SettingsConfigurationSnapshot>();
  const [draft, setDraft] = useState<SettingsEditorDraft>();
  const [configurationLoading, setConfigurationLoading] = useState(false);
  const [configurationError, setConfigurationError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const configRequest = useRef<AbortController | undefined>(undefined);

  const dirty = useMemo(() => {
    if (!configuration || !draft) return false;
    return JSON.stringify(draft.mainModel) !== JSON.stringify(configuration.mainModel) ||
      JSON.stringify(draft.backgroundModel) !== JSON.stringify(configuration.backgroundModel) ||
      draft.modelDirectory !== configuration.modelDirectory ||
      Object.values(draft.keyInputs).some(value => !!value.trim()) || draft.deleteProviders.length > 0;
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
    if (open) setPage("overview");
    else configRequest.current?.abort();
  }, [open]);
  useEffect(() => {
    if (open && page === "models" && !configuration && !configurationLoading) void refreshConfiguration();
  }, [open, page, configuration, configurationLoading, refreshConfiguration]);

  const save = useCallback(async (value: SettingsEditorDraft) => {
    if (!configuration) return;
    setSaving(true);
    setConfigurationError("");
    setSaveStatus("");
    const credentialOperations: SettingsCredentialOperation[] = [];
    for (const [providerId, key] of Object.entries(value.keyInputs))
      if (key.trim()) credentialOperations.push({ providerId, action: "set", key });
    const settingKeys = new Set(credentialOperations.map(item => item.providerId));
    for (const providerId of value.deleteProviders)
      if (!settingKeys.has(providerId)) credentialOperations.push({ providerId, action: "delete" });
    try {
      const result = await saveSettingsConfiguration({
        baseRevision: configuration.revision,
        mainModel: value.mainModel,
        backgroundModel: value.backgroundModel,
        modelDirectory: value.modelDirectory,
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
      } else setSaveStatus("设置已保存并应用。");
    } catch (cause) {
      setConfigurationError(cause instanceof Error ? cause.message : "保存设置失败，请重试。");
    } finally { setSaving(false); }
  }, [configuration, refresh]);

  const handleClose = () => {
    if (saving) return;
    if (dirty) { setDiscardPrompt(true); return; }
    onClose();
  };

  const modelsEditor = data ? <SettingsModelsEditor
    overview={data}
    snapshot={configuration}
    draft={draft}
    loading={configurationLoading}
    saving={saving}
    error={configurationError}
    status={saveStatus}
    onDraftChange={setDraft}
    onRefresh={() => void refreshConfiguration()}
    onSave={value => void save(value)}
  /> : undefined;

  return <>
    <FloatingPanel
      closeLabel="关闭设置"
      onClose={handleClose}
      open={open}
      testID="settings-sheet"
      title={settingsTitles[page]}
      contentKey={page}
      headerLeading={page !== "overview" ? (
        <IconButton label="返回设置" onPress={() => setPage("overview")} variant="plain">
          <ArrowLeft size={20} strokeWidth={1.8} color={colors.text} />
        </IconButton>
      ) : undefined}
      headerActions={(
        <IconButton label={page === "models" ? "重新读取模型配置" : "刷新设置概览"}
          disabled={page === "models" ? configurationLoading || saving || dirty : loading}
          onPress={() => page === "models" ? void refreshConfiguration() : void refresh()} variant="plain">
          <RefreshCw size={19} strokeWidth={1.8} color={colors.text} />
        </IconButton>
      )}
    >
      {loading && (
        <View style={styles.loading} accessibilityLiveRegion="polite">
          <ActivityIndicator accessibilityLabel={data ? "正在刷新设置" : "正在读取设置"} color={colors.blueDark} size="small" />
          <Text style={styles.note}>{data ? "正在刷新…" : "正在读取设置…"}</Text>
        </View>
      )}
      {!!error && (
        <View style={styles.notice}>
          <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
          {data ? <Text style={styles.note}>以下保留上次读取的内容，可能不是最新状态。</Text> : null}
          <TextButton label="重新读取设置" onPress={() => void refresh()} disabled={loading}>
            <Text style={styles.retry}>重试</Text>
          </TextButton>
        </View>
      )}
      {data ? <SettingsContent page={page} data={data} onNavigate={setPage} modelsEditor={modelsEditor} /> : null}
    </FloatingPanel>
    <Modal transparent visible={discardPrompt} animationType="fade" onRequestClose={() => setDiscardPrompt(false)}>
      {discardPrompt ? <ConfirmationDialogContent title="放弃未保存的设置？"
        message="关闭设置会丢弃当前模型目录或凭据草稿。已保存的配置不受影响。"
        onCancel={() => setDiscardPrompt(false)} onConfirm={() => { setDiscardPrompt(false); setDraft(configuration ? settingsDraft(configuration) : undefined); onClose(); }}
        confirmLabel="放弃修改" cancelLabel="继续编辑" /> : null}
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  loading: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 20, paddingVertical: 12 },
  note: { color: colors.muted, fontSize: 12, lineHeight: 19 },
  notice: { marginHorizontal: 20, marginBottom: 16, gap: 10, alignItems: "flex-start" },
  error: { color: colors.danger, fontSize: 14, lineHeight: 21 },
  retry: { color: colors.text, fontSize: 14, fontWeight: "500" },
});
