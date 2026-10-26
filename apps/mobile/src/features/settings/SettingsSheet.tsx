import { ChevronRight } from "lucide-react-native";
import { StyleSheet, Text, View } from "react-native";
import { FloatingPanel } from "../../components/FloatingPanel";
import { colors } from "../../theme";

const entries = ["模型", "通道", "工作区", "关于"];

/** Placeholder settings content shares the same button-dismissed overlay as file previews. */
export function SettingsSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <FloatingPanel
      closeLabel="关闭设置"
      onClose={onClose}
      open={open}
      testID="settings-sheet"
      title="设置"
    >
      {entries.map((label, index) => (
        <View key={label} style={[styles.row, index > 0 && styles.rowDivider]}>
          <Text style={styles.rowLabel}>{label}</Text>
          <ChevronRight size={18} strokeWidth={1.8} color={colors.muted} />
        </View>
      ))}
      <Text style={styles.note}>设置项尚未接入，先确认弹层的形态与动效。</Text>
    </FloatingPanel>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 56,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  rowLabel: {
    fontSize: 16,
    fontWeight: "500",
    color: colors.text,
  },
  note: {
    marginTop: 16,
    paddingHorizontal: 20,
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
  },
});
