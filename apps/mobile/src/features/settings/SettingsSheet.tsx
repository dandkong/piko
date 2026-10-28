import { useCallback, useEffect, useRef } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { FloatingPanel } from "../../components/FloatingPanel";
import { TextButton } from "../../components/TextButton";
import { colors } from "../../theme";
import type { FeedbackTone } from "../../components/FeedbackToast";
import type { ModelSelection, ThinkingLevel } from "../../../../../shared/runtime";
import type { ModelSettingsSnapshot, SaveModelSettings } from "../../../../../shared/settings";
import { saveModelSettings } from "./api";
import { SettingsModelsEditor } from "./SettingsModelsEditor";
import { useSettings } from "./useSettings";

/** The app edits only model role choices; all provider, tool and environment settings are deployment-managed. */
export function SettingsSheet({ open, onClose, onToast }: {
  open: boolean;
  onClose: () => void;
  onToast: (message: string, tone?: FeedbackTone) => void;
}) {
  const writesPending = useRef(false);
  const writer = useRef(false);
  const queuedDraft = useRef<Omit<SaveModelSettings, "baseRevision"> | undefined>(undefined);
  const confirmed = useRef<ModelSettingsSnapshot | undefined>(undefined);
  const desired = useRef<ModelSettingsSnapshot | undefined>(undefined);
  const { data, setData, loading, error, setError, refresh, invalidateReads } = useSettings(open, writesPending);

  useEffect(() => {
    if (!data || writesPending.current) return;
    confirmed.current = data;
    desired.current = data;
  }, [data]);

  const flush = useCallback(async () => {
    if (writer.current || !queuedDraft.current) return;
    writer.current = true;
    writesPending.current = true;
    invalidateReads();
    let refreshAfterFailure = false;
    try {
      while (queuedDraft.current) {
        const draft = queuedDraft.current;
        queuedDraft.current = undefined;
        const base = confirmed.current;
        if (!base) {
          queuedDraft.current = draft;
          break;
        }
        try {
          const result = await saveModelSettings({ ...draft, baseRevision: base.revision });
          confirmed.current = result.snapshot;
          const next = queuedDraft.current && desired.current
            ? { ...desired.current, revision: result.snapshot.revision }
            : result.snapshot;
          desired.current = next;
          setData(next);
        } catch (cause) {
          queuedDraft.current = undefined;
          desired.current = confirmed.current;
          if (confirmed.current) setData(confirmed.current);
          onToast(cause instanceof Error ? cause.message : "保存模型设置失败，请重试。", "error");
          refreshAfterFailure = true;
          break;
        }
      }
    } finally {
      writer.current = false;
      writesPending.current = false;
      if (refreshAfterFailure) void refresh();
    }
  }, [invalidateReads, onToast, refresh, setData]);

  const update = useCallback((
    mainModel: ModelSelection | null,
    backgroundModel: ModelSelection | null,
    backgroundThinking: ThinkingLevel | null,
  ) => {
    const current = desired.current ?? data;
    if (!current) return;
    confirmed.current ??= current;
    desired.current ??= current;
    const draft = { mainModel, backgroundModel, backgroundThinking };
    if (JSON.stringify(draft) === JSON.stringify({
      mainModel: current.mainModel,
      backgroundModel: current.backgroundModel,
      backgroundThinking: current.backgroundThinking,
    })) return;
    const next = { ...current, ...draft };
    desired.current = next;
    queuedDraft.current = draft;
    setData(next);
    setError("");
    void flush();
  }, [data, flush, setData, setError]);

  return <FloatingPanel
    closeLabel="关闭设置"
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
      onChange={(main, background, backgroundThinking) => void update(main, background, backgroundThinking)}
    /> : null}
  </FloatingPanel>;
}
