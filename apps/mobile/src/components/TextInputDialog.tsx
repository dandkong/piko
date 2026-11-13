import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View,
  type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import { useDismissOnBack } from "../hooks/useDismissOnBack";
import { radii, useTheme, useThemeStyles, type ThemeColors, type ThemeStateColors } from "../theme";
import { TextButton } from "./TextButton";
import { useTranslation } from "../i18n";

type InputFocusEvent = Parameters<NonNullable<TextInputProps["onFocus"]>>[0];
const webTextInputStyle = { outlineStyle: "none" } as unknown as TextStyle;

export type TextInputDialogProps = {
  title: string;
  inputLabel?: string;
  value: string;
  onChangeText: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  disabled?: boolean;
  error?: string;
  maxLength?: number;
  placeholder?: string;
  confirmLabel?: string;
  testID?: string;
};

/** Controlled single-line input. The caller initializes the value and closes it only after a successful save. */
export function TextInputDialog({ visible, ...props }: TextInputDialogProps & { visible: boolean }) {
  return <Modal transparent visible={visible} animationType="fade" onRequestClose={() => { if (!props.busy) props.onCancel(); }}>
    {visible && <TextInputDialogContent {...props} />}
  </Modal>;
}

/** Reuse inside an existing Modal when a menu transitions into an input without stacking native modals. */
export function TextInputDialogContent({ title, inputLabel = title, value, onChangeText, onConfirm, onCancel,
  busy = false, disabled = false, error, maxLength, placeholder, confirmLabel, testID }: TextInputDialogProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemeStyles(createStyles);
  const canConfirm = !busy && !disabled && !!value.trim();
  const [focused, setFocused] = useState(false);
  const [focusVisible, setFocusVisible] = useState(false);
  useDismissOnBack(true, () => { if (!busy) onCancel(); }, { capture: true });
  return <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : Platform.OS === "android" ? "height" : undefined}>
    <Pressable accessibilityRole="button" accessibilityLabel={t("common.closeDialog", { title })} disabled={busy}
      style={[StyleSheet.absoluteFill, styles.scrim]} onPress={onCancel} />
    <View role="dialog" accessibilityLabel={title} accessibilityViewIsModal testID={testID} style={styles.dialog}>
      <Text style={styles.title}>{title}</Text>
      <View style={[styles.inputField, focused && styles.inputFieldFocused, focusVisible && styles.inputFieldFocusVisible]}>
        <TextInput accessibilityLabel={inputLabel} autoFocus selectTextOnFocus value={value} onChangeText={onChangeText}
          maxLength={maxLength} placeholder={placeholder} placeholderTextColor={colors.muted} editable={!busy && !disabled}
          onFocus={(event: InputFocusEvent) => {
            setFocused(true);
            const target = event.currentTarget as unknown as { matches?: (selector: string) => boolean } | null;
            setFocusVisible(Platform.OS === "web" && (target?.matches ? target.matches(":focus-visible") : true));
          }}
          onBlur={() => { setFocused(false); setFocusVisible(false); }}
          style={[styles.input, Platform.OS === "web" && webTextInputStyle]}
          returnKeyType="done" onSubmitEditing={() => { if (canConfirm) onConfirm(); }} />
      </View>
      {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        <TextButton label={t("common.cancelDialog", { title })} disabled={busy} onPress={onCancel}><Text style={styles.muted}>{t("common.cancel")}</Text></TextButton>
        <TextButton label={t("common.confirmDialog", { title })} variant="primary" disabled={!canConfirm} onPress={onConfirm}>
          <Text style={styles.text}>{busy ? t("common.saving") : confirmLabel ?? t("common.confirm")}</Text>
        </TextButton>
      </View>
    </View>
  </KeyboardAvoidingView>;
}
function createStyles(colors: ThemeColors, stateColors: ThemeStateColors) {
  return StyleSheet.create({
  root: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  scrim: { backgroundColor: colors.scrim },
  dialog: { width: "100%", maxWidth: 360, padding: 22, gap: 18, borderRadius: radii.card, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line },
  title: { color: colors.text, fontSize: 18, fontWeight: "600" },
  inputField: { minHeight: 48, borderWidth: 1, borderColor: colors.line, borderRadius: radii.control, backgroundColor: colors.panel },
  inputFieldFocused: { borderColor: stateColors.focus },
  inputFieldFocusVisible: { boxShadow: `0 0 0 1px ${stateColors.focus}` } as unknown as ViewStyle,
  input: { minHeight: 46, paddingHorizontal: 12, color: colors.text, fontSize: 15 },
  text: { color: colors.text, fontSize: 15 }, muted: { color: colors.muted, fontSize: 13 }, error: { color: colors.danger, fontSize: 13 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  });
}
