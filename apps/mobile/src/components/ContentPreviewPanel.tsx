import { ActivityIndicator, Platform, StyleSheet, Text, View, type TextStyle } from "react-native";
import { FileText } from "lucide-react-native";
import { FloatingPanel } from "./FloatingPanel";
import { colors } from "../theme";
import { AssistantMessage } from "../features/chat/AssistantMessage";

/** The shared in-app reader. Content loading stays with the feature that owns it. */
export function ContentPreviewPanel({ open, title, onClose, closeLabel, content, preview, loading = false, error = "",
  testID, scrollTestID, markdownTestID, textTestID }: {
  open: boolean;
  title: string;
  onClose: () => void;
  closeLabel: string;
  content: string;
  preview?: "markdown" | "text";
  loading?: boolean;
  error?: string;
  testID: string;
  scrollTestID?: string;
  markdownTestID?: string;
  textTestID?: string;
}) {
  return <FloatingPanel open={open} title={title} onClose={onClose} closeLabel={closeLabel}
    testID={testID} scrollTestID={scrollTestID} showScrollbar>
    {open && <View style={styles.content}>
      {!preview ? <View style={styles.unsupported} testID={`${testID.replace(/-panel$/, "")}-unsupported`}>
        <FileText size={28} strokeWidth={1.6} color={colors.muted} />
        <Text style={styles.messageTitle}>暂不支持预览此文件</Text>
      </View> : loading ? <ActivityIndicator accessibilityLabel="正在加载预览" color={colors.muted} />
        : error ? <View style={styles.unsupported} testID={`${testID.replace(/-panel$/, "")}-error`}>
          <FileText size={28} strokeWidth={1.6} color={colors.muted} />
          <Text style={styles.messageTitle}>无法在 Piko 中预览</Text>
          <Text accessibilityRole="alert" style={styles.description}>{error}</Text>
        </View> : preview === "markdown" ? <View testID={markdownTestID}><AssistantMessage content={content} /></View>
          : <Text selectable style={[styles.text, Platform.OS === "web" && { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } as TextStyle]}
            testID={textTestID}>{content}</Text>}
    </View>}
  </FloatingPanel>;
}
const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 16, gap: 12 },
  text: { color: colors.text, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 14, lineHeight: 21 },
  unsupported: { alignItems: "flex-start", gap: 10, paddingVertical: 16 },
  messageTitle: { color: colors.text, fontSize: 17, fontWeight: "600" },
  description: { color: colors.muted, fontSize: 14, lineHeight: 21 },
});
