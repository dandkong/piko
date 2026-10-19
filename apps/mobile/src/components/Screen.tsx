import type { ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { colors } from "../theme";

/** Every non-chat tab shares this page rhythm so the modules feel like one product. */
export function Screen({ children, topInset, bottomInset, testID }: {
  children: ReactNode;
  topInset: number;
  bottomInset: number;
  testID?: string;
}) {
  return <ScrollView testID={testID} contentContainerStyle={[styles.page, { paddingTop: topInset, paddingBottom: bottomInset }]}>
    {children}
  </ScrollView>;
}

export function ScreenHeader({ title, action }: { title: string; action?: ReactNode }) {
  return <View style={styles.header}>
    <Text style={styles.title}>{title}</Text>
    <View style={styles.spacer} />
    {action}
  </View>;
}

export function ScreenCard({ children, muted = false, style }: { children: ReactNode; muted?: boolean; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, muted && styles.muted, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, gap: 12 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  title: { fontSize: 22, fontWeight: "600", color: colors.text, flexShrink: 1 },
  spacer: { flex: 1 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 18, padding: 16, gap: 10 },
  muted: { opacity: 0.55 },
});
