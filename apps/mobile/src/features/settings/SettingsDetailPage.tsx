import type { ReactNode } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { ChevronLeft } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconButton } from "../../components/IconButton";
import { colors } from "../../theme";

/** Shared second-level settings layer: circular back control, centered title, and fixed bottom actions. */
export function SettingsDetailPage({ title, onBack, children, footer, contentKey, testID }: {
  title: string;
  onBack: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  contentKey?: string;
  testID?: string;
}) {
  const insets = useSafeAreaInsets();
  return <KeyboardAvoidingView style={styles.layer}
    behavior={Platform.OS === "ios" ? "padding" : Platform.OS === "android" ? "height" : undefined}>
    <View style={[styles.layer, { paddingBottom: insets.bottom }]} testID={testID} accessibilityViewIsModal>
      <View style={styles.header}>
        <IconButton label="返回设置" onPress={onBack} size="md">
          <ChevronLeft size={21} strokeWidth={1.9} color={colors.text} />
        </IconButton>
        <View pointerEvents="none" style={styles.titlePosition}>
          <Text numberOfLines={1} style={styles.title}>{title}</Text>
        </View>
        <View style={styles.trailingSpace} />
      </View>
      <ScrollView key={contentKey} style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </View>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  layer: { flex: 1, backgroundColor: colors.canvas },
  header: {
    minHeight: 74,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 12,
  },
  titlePosition: { position: "absolute", left: 72, right: 72, top: 18, bottom: 12, alignItems: "center", justifyContent: "center" },
  title: { color: colors.text, fontSize: 22, lineHeight: 28, fontWeight: "600", textAlign: "center" },
  trailingSpace: { width: 44, height: 44 },
  scroll: { flex: 1 },
  content: { flexGrow: 1, paddingBottom: 24 },
  footer: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 12, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.canvas },
});
