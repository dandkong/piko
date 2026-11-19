import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { FileText } from "lucide-react-native";
import { filePreviewKind, type FilePreviewKind } from "../../../../../shared/file-preview";
import type { MessageAttachment } from "../../../../../shared/chat";
import { apiFetch, readJson } from "../../api/client";
import { ApiError, errorMessage } from "../../api/errors";
import { ContentPreviewPanel } from "../../components/ContentPreviewPanel";
import { useTranslation } from "../../i18n";
import { useTheme } from "../../theme";
import { attachmentActionUrl } from "./api";

export function AttachmentPreviewPanel({ file, onClose }: { file?: MessageAttachment; onClose: () => void }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const name = file?.name ?? file?.id ?? "";
  const format = filePreviewKind(name);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ url: string; content?: string; error?: string }>();
  useEffect(() => {
    setResult(undefined);
    if (!file || !format) return;
    const controller = new AbortController();
    void apiFetch(attachmentActionUrl(file.url, "preview"), { signal: controller.signal })
      .then(response => readJson<{ content: string; preview: FilePreviewKind }>(response))
      .then(value => { if (!controller.signal.aborted) setResult({ url: file.url, content: value.content }); })
      .catch(value => {
        if (controller.signal.aborted) return;
        setResult({ url: file.url, error: value instanceof ApiError && value.status === 413 ? t("artifacts.tooLarge")
          : value instanceof ApiError && value.status === 404 ? t("artifacts.missing") : errorMessage(value, t("artifacts.readFailed"), t) });
      });
    return () => controller.abort();
  }, [file?.url, format, revision, t]);
  const current = result?.url === file?.url ? result : undefined;
  const unsupported = file && !format ? <View style={{ alignItems: "flex-start", gap: 10, paddingVertical: 16 }}>
    <FileText size={28} strokeWidth={1.6} color={colors.muted} />
    <Text style={{ color: colors.text, fontSize: 17, fontWeight: "600" }}>{t("artifacts.unsupported")}</Text>
  </View> : undefined;
  return <ContentPreviewPanel open={!!file} title={name} onClose={onClose} closeLabel={t("chat.closeAttachmentPreview")}
    content={current?.content ?? ""} format={format ?? "text"} loading={!!file && !!format && !current}
    error={current?.error} onRetry={() => setRevision(value => value + 1)} fallback={unsupported}
    testID="attachment-preview-panel" scrollTestID="attachment-preview-scroll" />;
}
