import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, View, type TextStyle } from "react-native";
import { FileText } from "lucide-react-native";
import type { ArtifactEntry } from "../../../../../shared/artifacts";
import { FloatingPanel } from "../../components/FloatingPanel";
import { colors } from "../../theme";
import { AssistantMessage } from "../chat/AssistantMessage";
import { loadArtifactPreview } from "./api";

/** In-app reader for supported Markdown/text files and a clear fallback for other types. */
export function ArtifactPreviewPanel({
  file,
  onClose,
}: {
  file?: ArtifactEntry;
  onClose: () => void;
}) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setContent("");
    setError("");
    if (!file?.preview) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    void loadArtifactPreview(file.path, controller.signal).then(result => {
      if (!controller.signal.aborted) setContent(result.content);
    }).catch(value => {
      if (controller.signal.aborted) return;
      const message = value instanceof Error ? value.message.toLowerCase() : "";
      setError(message.includes("too large")
        ? "文件超过 1 MiB 的内置预览限制。"
        : "无法读取这个文件。")
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [file?.path, file?.preview]);


  const preview = file?.preview;
  const textStyle = [styles.text, Platform.OS === "web" && {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  } as TextStyle];

  return (
    <FloatingPanel
      open={!!file}
      title={file?.name ?? "产物预览"}
      onClose={onClose}
      closeLabel="关闭产物预览"
      testID="artifact-preview-panel"
      scrollTestID="artifact-preview-scroll"
      showScrollbar
    >
      {file && (
        <View style={styles.content}>
          {!preview ? (
            <View style={styles.unsupported} testID="artifact-preview-unsupported">
              <FileText size={28} strokeWidth={1.6} color={colors.muted} />
              <Text style={styles.messageTitle}>暂不支持预览此文件</Text>
            </View>
          ) : loading ? (
            <ActivityIndicator accessibilityLabel="正在加载预览" color={colors.muted} />
          ) : error ? (
            <View style={styles.unsupported} testID="artifact-preview-error">
              <FileText size={28} strokeWidth={1.6} color={colors.muted} />
              <Text style={styles.messageTitle}>无法在 Piko 中预览</Text>
              <Text accessibilityRole="alert" style={styles.description}>{error}</Text>
            </View>
          ) : preview === "markdown" ? (
            <View testID="artifact-markdown-preview"><AssistantMessage content={content} /></View>
          ) : (
            <Text selectable style={textStyle} testID="artifact-text-preview">
              {content}
            </Text>
          )}
        </View>
      )}
    </FloatingPanel>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 16, gap: 12 },
  text: {
    color: colors.text,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 14,
    lineHeight: 21,
  },
  unsupported: { alignItems: "flex-start", gap: 10, paddingVertical: 16 },
  messageTitle: { color: colors.text, fontSize: 17, fontWeight: "600" },
  description: { color: colors.muted, fontSize: 14, lineHeight: 21 },

});
