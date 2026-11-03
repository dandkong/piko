import { StyleSheet, Text, View } from "react-native";
import { TextButton } from "./TextButton";
import { radii, useThemeStyles, type ThemeColors, type ThemeStateColors } from "../theme";

/** Local feedback, not a global error owner. Retry always belongs to the failed operation. */
export function ErrorNotice({ message, title, actionLabel, onAction, onDismiss, busy = false, tone = "error", testID }: {
  message: string; title?: string; actionLabel?: string; onAction?: () => void;
  onDismiss?: () => void; busy?: boolean; tone?: "error" | "info"; testID?: string;
}) {
  const styles = useThemeStyles(createStyles);
  return <View style={[styles.notice, tone === "info" && styles.info]} testID={testID}>
    {title ? <Text style={styles.title}>{title}</Text> : null}
    <Text accessibilityRole={tone === "error" ? "alert" : "text"} accessibilityLiveRegion="polite"
      style={[styles.message, tone === "info" && styles.infoText]}>{message}</Text>
    {(onAction || onDismiss) ? <View style={styles.actions}>
      {onAction && actionLabel ? <TextButton label={actionLabel} onPress={onAction} disabled={busy} variant="plain">
        <Text style={styles.button}>{actionLabel}</Text>
      </TextButton> : null}
      {onDismiss ? <TextButton label="关闭提示" onPress={onDismiss} disabled={busy} variant="plain">
        <Text style={styles.muted}>关闭</Text>
      </TextButton> : null}
    </View> : null}
  </View>;
}
function createStyles(colors: ThemeColors, stateColors: ThemeStateColors) {
  return StyleSheet.create({
  notice: { padding: 14, gap: 8, borderRadius: radii.control, backgroundColor: colors.dangerSurface },
  info: { backgroundColor: stateColors.soft },
  title: { color: colors.text, fontSize: 16, fontWeight: "600" },
  message: { color: colors.danger, fontSize: 14, lineHeight: 21 },
  infoText: { color: colors.muted },
  actions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  button: { color: colors.text, fontSize: 14, fontWeight: "500" },
  muted: { color: colors.muted, fontSize: 14 },
  });
}
