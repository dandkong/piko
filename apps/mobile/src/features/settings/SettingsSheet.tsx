import { useEffect, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react-native";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { FloatingPanel } from "../../components/FloatingPanel";
import { IconButton } from "../../components/IconButton";
import { TextButton } from "../../components/TextButton";
import { colors } from "../../theme";
import { SettingsContent, settingsTitles, type SettingsPage } from "./SettingsContent";
import { useSettings } from "./useSettings";

/** A real read-only overview; editing is added only with safe persistence and apply semantics. */
export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [page, setPage] = useState<SettingsPage>("overview");
  const { data, loading, error, refresh } = useSettings(open);
  useEffect(() => { if (open) setPage("overview"); }, [open]);

  return (
    <FloatingPanel
      closeLabel="关闭设置"
      onClose={onClose}
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
        <IconButton label="刷新设置概览" disabled={loading} onPress={() => void refresh()} variant="plain">
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
      {data ? <SettingsContent page={page} data={data} onNavigate={setPage} /> : null}
    </FloatingPanel>
  );
}

const styles = StyleSheet.create({
  loading: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 20, paddingVertical: 12 },
  note: { color: colors.muted, fontSize: 12, lineHeight: 19 },
  notice: { marginHorizontal: 20, marginBottom: 16, gap: 10, alignItems: "flex-start" },
  error: { color: colors.danger, fontSize: 14, lineHeight: 21 },
  retry: { color: colors.text, fontSize: 14, fontWeight: "500" },
});
