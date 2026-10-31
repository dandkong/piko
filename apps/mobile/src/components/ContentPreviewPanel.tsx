import type { ReactNode } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, View, type TextStyle } from "react-native";
import { FloatingPanel } from "./FloatingPanel";
import { MarkdownContent } from "./MarkdownContent";
import { colors } from "../theme";
import { ErrorNotice } from "./ErrorNotice";

/** Shared reader for loaded text. Feature owners handle fetching and business-specific fallback content. */
export function ContentPreviewPanel({ open, title, onClose, closeLabel, content, format, loading = false, error = "", fallback,
  testID, scrollTestID, markdownTestID, textTestID, onRetry }: {
  open: boolean;
  title?: string;
  onClose: () => void;
  closeLabel: string;
  content: string;
  format: "markdown" | "text";
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  fallback?: ReactNode;
  testID: string;
  scrollTestID?: string;
  markdownTestID?: string;
  textTestID?: string;
}) {
  return <FloatingPanel open={open} title={title} onClose={onClose} closeLabel={closeLabel}
    testID={testID} scrollTestID={scrollTestID} showScrollbar>
    {open && <View style={styles.content}>
      {loading ? <ActivityIndicator accessibilityLabel="正在加载预览" color={colors.muted} />
        : error ? <ErrorNotice title="无法加载内容" message={error} onAction={onRetry}
          actionLabel="重新加载内容" testID={`${testID.replace(/-panel$/, "")}-error`} /> : fallback ?? (format === "markdown" ? <View testID={markdownTestID}><MarkdownContent content={content} /></View>
          : <Text selectable style={[styles.text, Platform.OS === "web" && { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } as TextStyle]}
            testID={textTestID}>{content}</Text>)}
    </View>}
  </FloatingPanel>;
}
const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 16, gap: 12 },
  text: { color: colors.text, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 14, lineHeight: 21 },
});
