import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { FloatingPanel } from "../../components/FloatingPanel";
import { useTheme } from "../../theme";
import { AppearanceSection } from "./AppearanceSection";
import type { FeedbackTone } from "../../components/FeedbackToast";
import type { ModelSelection, ThinkingLevel } from "../../../../../shared/runtime";
import type { ModelSettingsSnapshot, SaveModelSettings } from "../../../../../shared/settings";
import { saveModelSettings } from "./api";
import { SettingsModelsEditor } from "./SettingsModelsEditor";
import { useSettings } from "./useSettings";
import { ErrorNotice } from "../../components/ErrorNotice";
import { errorMessage } from "../../api/errors";

/** The app edits only model role choices; all provider, tool and environment settings are deployment-managed. */
export function SettingsSheet({ open, onClose, onToast }: {
  open: boolean;
  onClose: () => void;
  onToast: (message: string, tone?: FeedbackTone) => void;
}) {
  const { colors } = useTheme();
  const [saveError, setSaveError] = useState("");
  const openRef = useRef(open);
  openRef.current = open;
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
          const message = `${errorMessage(cause, "暂未确认模型设置保存结果。")} 界面先恢复上次确认的选择，请重新读取核对。`;
          setSaveError(message);
          if (!openRef.current) onToast(message, "error");
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
    setSaveError("");
    void flush();
  }, [data, flush, setData, setError]);

  return <FloatingPanel
    closeLabel="关闭设置"
    onClose={onClose}
    open={open}
    testID="settings-sheet"
    title="设置"
  >
    {open ? <View style={{ gap: 16 }}>
    <AppearanceSection />
    {loading && !data ? (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 20, paddingVertical: 12 }}>
        <ActivityIndicator accessibilityLabel="正在读取模型设置" color={colors.muted} size="small" />
        <Text style={{ color: colors.muted, fontSize: 12 }}>正在读取…</Text>
      </View>
    ) : null}
    {(saveError || error) ? <View style={{ marginHorizontal: 20, marginBottom: 12 }}>
      <ErrorNotice message={saveError || error} actionLabel="重新读取模型设置" busy={loading}
        onAction={() => void refresh().then(ok => { if (ok) setSaveError(""); })} testID="settings-error-notice" />
    </View> : null}
    {data ? <SettingsModelsEditor
      snapshot={data}
      onChange={(main, background, backgroundThinking) => void update(main, background, backgroundThinking)}
    /> : null}
    </View> : null}
  </FloatingPanel>;
}
