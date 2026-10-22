import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useDismissOnBack } from "../hooks/useDismissOnBack";
import { colors, radii } from "../theme";
import { TextButton } from "./TextButton";

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
  busy = false, disabled = false, error, maxLength, placeholder, confirmLabel = "确认", testID }: TextInputDialogProps) {
  const canConfirm = !busy && !disabled && !!value.trim();
  useDismissOnBack(true, () => { if (!busy) onCancel(); }, { capture: true });
  return <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : Platform.OS === "android" ? "height" : undefined}>
    <Pressable accessibilityRole="button" accessibilityLabel={`关闭${title}弹窗`} disabled={busy}
      style={[StyleSheet.absoluteFill, styles.scrim]} onPress={onCancel} />
    <View role="dialog" accessibilityLabel={title} accessibilityViewIsModal testID={testID} style={styles.dialog}>
      <Text style={styles.title}>{title}</Text>
      <TextInput accessibilityLabel={inputLabel} autoFocus selectTextOnFocus value={value} onChangeText={onChangeText}
        maxLength={maxLength} placeholder={placeholder} editable={!busy && !disabled} style={styles.input}
        returnKeyType="done" onSubmitEditing={() => { if (canConfirm) onConfirm(); }} />
      {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        <TextButton label={`取消${title}`} disabled={busy} onPress={onCancel}><Text style={styles.muted}>取消</Text></TextButton>
        <TextButton label={`确认${title}`} variant="primary" disabled={!canConfirm} onPress={onConfirm}>
          <Text style={styles.text}>{busy ? "保存中…" : confirmLabel}</Text>
        </TextButton>
      </View>
    </View>
  </KeyboardAvoidingView>;
}
const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  scrim: { backgroundColor: `${colors.text}33` },
  dialog: { width: "100%", maxWidth: 360, padding: 22, gap: 18, borderRadius: radii.card, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  title: { color: colors.text, fontSize: 18, fontWeight: "600" },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.line, borderRadius: radii.control, paddingHorizontal: 12, color: colors.text, fontSize: 15 },
  text: { color: colors.text, fontSize: 15 }, muted: { color: colors.muted, fontSize: 13 }, error: { color: colors.danger, fontSize: 13 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
});
