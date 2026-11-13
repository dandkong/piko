import { StyleSheet, Text, View } from "react-native";
import { radii, useThemeStyles, type ThemeColors, type ThemeStateColors } from "../theme";
import { TextButton } from "./TextButton";
import { useTranslation } from "../i18n";

type Props = {
  title: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  busyLabel?: string;
  busy?: boolean;
  error?: string;
  testID?: string;
};

/** Shared destructive confirmation content; callers own the Modal and dismissal path. */
export function ConfirmationDialogContent({
  title,
  message,
  onCancel,
  onConfirm,
  confirmLabel,
  cancelLabel,
  busyLabel,
  busy = false,
  error,
  testID,
}: Props) {
  const styles = useThemeStyles(createStyles);
  const { t } = useTranslation();
  const confirm = confirmLabel ?? t("common.delete");
  const cancel = cancelLabel ?? t("common.cancel");
  const busyText = busyLabel ?? t("common.deleting");
  return (
    <View style={styles.root}>
      <View pointerEvents="none" style={styles.scrim} />
      <View
        accessibilityViewIsModal
        accessibilityLabel={title}
        role="dialog"
        testID={testID}
        style={styles.dialog}
      >
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.message}>{message}</Text>
        {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
        <View style={styles.actions}>
          <TextButton label={cancel} disabled={busy} onPress={onCancel}>
            <Text style={styles.secondary}>{cancel}</Text>
          </TextButton>
          <TextButton label={confirm} disabled={busy} onPress={onConfirm}>
            <Text style={styles.danger}>{busy ? busyText : confirm}</Text>
          </TextButton>
        </View>
      </View>
    </View>
  );
}

function createStyles(colors: ThemeColors, _stateColors: ThemeStateColors) {
  return StyleSheet.create({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  scrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.scrim,
  },
  dialog: {
    width: "100%",
    maxWidth: 380,
    padding: 22,
    gap: 16,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.card,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: "600" },
  message: { color: colors.text, fontSize: 15, lineHeight: 22 },
  error: { color: colors.danger, fontSize: 13, lineHeight: 19 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  secondary: { color: colors.muted, fontSize: 14 },
  danger: { color: colors.danger, fontSize: 14, fontWeight: "600" },
  });
}
