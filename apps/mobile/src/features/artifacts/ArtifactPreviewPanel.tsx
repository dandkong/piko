import { useEffect, useState } from "react";
import type { ArtifactEntry } from "../../../../../shared/artifacts";
import { ContentPreviewPanel } from "../../components/ContentPreviewPanel";
import { loadArtifactPreview } from "./api";

/** Artifact access remains restricted to its existing API; rendering shares the in-app reader. */
export function ArtifactPreviewPanel({ file, onClose }: { file?: ArtifactEntry; onClose: () => void }) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setContent(""); setError("");
    if (!file?.preview) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    void loadArtifactPreview(file.path, controller.signal).then(result => {
      if (!controller.signal.aborted) setContent(result.content);
    }).catch(value => {
      if (controller.signal.aborted) return;
      const message = value instanceof Error ? value.message.toLowerCase() : "";
      setError(message.includes("too large") ? "文件超过 1 MiB 的内置预览限制。" : "无法读取这个文件。");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [file?.path, file?.preview]);
  return <ContentPreviewPanel open={!!file} title={file?.name ?? "产物预览"} onClose={onClose} closeLabel="关闭产物预览"
    content={content} preview={file?.preview ?? undefined} loading={loading} error={error} testID="artifact-preview-panel"
    scrollTestID="artifact-preview-scroll" markdownTestID="artifact-markdown-preview" textTestID="artifact-text-preview" />;
}
