import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { FileText } from "lucide-react-native";
import type { ArtifactEntry } from "../../../../../shared/artifacts";
import { ContentPreviewPanel } from "../../components/ContentPreviewPanel";
import { colors } from "../../theme";
import { loadArtifactPreview } from "./api";

/** File loading, unsupported types and size errors belong to Artifacts, not the shared reader. */
export function ArtifactPreviewPanel({ file, onClose }: { file?: ArtifactEntry; onClose: () => void }) {
  const [result, setResult] = useState<{ path: string; content?: string; error?: string }>();
  useEffect(() => {
    setResult(undefined);
    if (!file?.preview) return;
    const controller = new AbortController();
    void loadArtifactPreview(file.path, controller.signal).then(value => {
      if (!controller.signal.aborted) setResult({ path: file.path, content: value.content });
    }).catch(value => {
      if (controller.signal.aborted) return;
      const message = value instanceof Error ? value.message.toLowerCase() : "";
      setResult({ path: file.path, error: message.includes("too large") ? "文件超过 1 MiB 的内置预览限制。" : "无法读取这个文件。" });
    });
    return () => controller.abort();
  }, [file?.path, file?.preview]);
  const current = result?.path === file?.path ? result : undefined;
  const unsupported = file && !file.preview ? <View style={styles.unsupported} testID="artifact-preview-unsupported">
    <FileText size={28} strokeWidth={1.6} color={colors.muted} />
    <Text style={styles.message}>暂不支持预览此文件</Text>
  </View> : undefined;
  return <ContentPreviewPanel open={!!file} title={file?.name} onClose={onClose} closeLabel="关闭产物预览"
    content={current?.content ?? ""} format={file?.preview ?? "text"} loading={!!file?.preview && !current}
    error={current?.error} fallback={unsupported} testID="artifact-preview-panel"
    scrollTestID="artifact-preview-scroll" markdownTestID="artifact-markdown-preview" textTestID="artifact-text-preview" />;
}
const styles = StyleSheet.create({
  unsupported: { alignItems: "flex-start", gap: 10, paddingVertical: 16 },
  message: { color: colors.text, fontSize: 17, fontWeight: "600" },
});
