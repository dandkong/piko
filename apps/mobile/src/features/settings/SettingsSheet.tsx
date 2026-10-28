import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { FloatingPanel } from "../../components/FloatingPanel";
import { TextButton } from "../../components/TextButton";
import { colors } from "../../theme";
import type { ModelSelection, ThinkingLevel } from "../../../../../shared/runtime";
import { saveModelSettings } from "./api";
import { SettingsModelsEditor } from "./SettingsModelsEditor";
import { useSettings } from "./useSettings";

/** The app edits only model role choices; all provider, tool and environment settings are deployment-managed. */
export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, setData, loading, error, setError, refresh } = useSettings(open);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (open) setStatus("");
  }, [open]);

  const update = useCallback(async (
    mainModel: ModelSelection | null,
    backgroundModel: ModelSelection | null,
    backgroundThinking: ThinkingLevel | null,
  ) => {
    if (!data || saving) return;
    if (JSON.stringify({ mainModel, backgroundModel, backgroundThinking }) === JSON.stringify({
      mainModel: data.mainModel,
      backgroundModel: data.backgroundModel,
      backgroundThinking: data.backgroundThinking,
    })) return;
    const mainChanged = JSON.stringify(mainModel) !== JSON.stringify(data.mainModel);
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const result = await saveModelSettings({
        baseRevision: data.revision,
        mainModel,
        backgroundModel,
        backgroundThinking,
      });
      setData(result.snapshot);
      if (mainChanged && result.pendingConversations > 0)
        setStatus(`主模型已保存；${result.pendingConversations} 个忙碌会话将在下一轮对齐。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存模型设置失败，请重试。");
    } finally {
      setSaving(false);
    }
  }, [data, saving, setData, setError]);

  return <FloatingPanel
    closeLabel="关闭设置"
    closeDisabled={saving}
    onClose={onClose}
    open={open}
    testID="settings-sheet"
    title="模型"
  >
    {open && loading && !data ? (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 20, paddingVertical: 12 }}>
        <ActivityIndicator accessibilityLabel="正在读取模型设置" color={colors.muted} size="small" />
        <Text style={{ color: colors.muted, fontSize: 12 }}>正在读取…</Text>
      </View>
    ) : null}
    {open && error ? <View style={{ marginHorizontal: 20, marginBottom: 12, gap: 8 }}>
      <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 14, lineHeight: 21 }}>{error}</Text>
      <TextButton label="重试读取模型设置" onPress={() => void refresh()} disabled={loading}>
        <Text style={{ color: colors.text, fontSize: 14, fontWeight: "500" }}>重试</Text>
      </TextButton>
    </View> : null}
    {open && data ? <SettingsModelsEditor
      snapshot={data}
      saving={saving}
      status={status}
      onChange={(main, background, backgroundThinking) => void update(main, background, backgroundThinking)}
    /> : null}
  </FloatingPanel>;
}
