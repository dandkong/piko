import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { FileText } from "lucide-react-native";
import type { ArtifactEntry } from "../../../../../shared/artifacts";
import { ContentPreviewPanel } from "../../components/ContentPreviewPanel";
import { useTheme, useThemeStyles, type ThemeColors, type ThemeStateColors } from "../../theme";
import { loadArtifactPreview } from "./api";
import { ApiError, errorMessage } from "../../api/errors";

/** File loading, unsupported types and size errors belong to Artifacts, not the shared reader. */
export function ArtifactPreviewPanel({ file, onClose }: { file?: ArtifactEntry; onClose: () => void }) {
  const { colors } = useTheme();
  const styles = useThemeStyles(createStyles);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ path: string; content?: string; error?: string }>();
  useEffect(() => {
    setResult(undefined);
    if (!file?.preview) return;
    const controller = new AbortController();
    void loadArtifactPreview(file.path, controller.signal).then(value => {
      if (!controller.signal.aborted) setResult({ path: file.path, content: value.content });
    }).catch(value => {
      if (controller.signal.aborted) return;
      setResult({ path: file.path, error: value instanceof ApiError && value.status === 413 ? "文件超过 1 MiB 的内置预览限制。"
        : value instanceof ApiError && value.status === 404 ? "这个文件已不存在。请关闭预览并刷新列表。" : errorMessage(value, "无法读取这个文件，请重新加载。") });
    });
    return () => controller.abort();
  }, [file?.path, file?.preview, revision]);
  const current = result?.path === file?.path ? result : undefined;
  const unsupported = file && !file.preview ? <View style={styles.unsupported} testID="artifact-preview-unsupported">
    <FileText size={28} strokeWidth={1.6} color={colors.muted} />
    <Text style={styles.message}>暂不支持预览此文件</Text>
  </View> : undefined;
  return <ContentPreviewPanel open={!!file} title={file?.name} onClose={onClose} closeLabel="关闭产物预览"
    content={current?.content ?? ""} format={file?.preview ?? "text"} loading={!!file?.preview && !current}
    error={current?.error} onRetry={() => setRevision(value => value + 1)} fallback={unsupported} testID="artifact-preview-panel"
    scrollTestID="artifact-preview-scroll" markdownTestID="artifact-markdown-preview" textTestID="artifact-text-preview" />;
}
function createStyles(colors: ThemeColors, _stateColors: ThemeStateColors) {
  return StyleSheet.create({
  unsupported: { alignItems: "flex-start", gap: 10, paddingVertical: 16 },
  message: { color: colors.text, fontSize: 17, fontWeight: "600" },
  });
}
