import { StyleSheet, Text, View } from "react-native";
import { radii, useThemeStyles, type ThemeColors, type ThemeStateColors } from "../theme";

export type FeedbackTone = "info" | "warning" | "error";
export type FeedbackToastMessage = { message: string; tone: FeedbackTone };

export function FeedbackToast({ feedback, top }: { feedback: FeedbackToastMessage; top: number }) {
  const styles = useThemeStyles(createStyles);
  const toneStyle = feedback.tone === "error" ? styles.error
    : feedback.tone === "warning" ? styles.warning : styles.info;

  return <View pointerEvents="none" testID="app-toast"
    accessibilityRole={feedback.tone === "error" ? "alert" : "text"}
    accessibilityLiveRegion={feedback.tone === "error" ? "assertive" : "polite"}
    style={[styles.toast, toneStyle, { top }]}>
    <Text style={[styles.text, feedback.tone === "error" && styles.errorText]}>{feedback.message}</Text>
  </View>;
}

function createStyles(colors: ThemeColors, stateColors: ThemeStateColors) {
  return StyleSheet.create({
  toast: {
    position: "absolute",
    alignSelf: "center",
    maxWidth: "88%",
    zIndex: 30,
    elevation: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radii.control,
    borderWidth: 1,
    shadowColor: colors.text,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.14,
    shadowRadius: 10,
  },
  info: { borderColor: colors.line, backgroundColor: colors.card },
  warning: { borderColor: colors.lineStrong, backgroundColor: stateColors.soft },
  error: { borderColor: colors.line, backgroundColor: colors.dangerSurface },
  text: { color: colors.text, fontSize: 13, lineHeight: 19, textAlign: "center" },
  errorText: { color: colors.danger },
  });
}
