import { useEffect, useState } from "react";
import { ContentPreviewPanel } from "../../components/ContentPreviewPanel";
import { loadExecution } from "./api";
import { ApiError, errorMessage } from "../../api/errors";
import { useTranslation } from "../../i18n";

export type TaskExecutionPreviewTarget = { taskId: string; executionId: string };

export function TaskExecutionPreviewPanel({ target, onClose }: {
  target?: TaskExecutionPreviewTarget;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<(TaskExecutionPreviewTarget & { content?: string; error?: string })>();
  useEffect(() => {
    setResult(undefined);
    if (!target) return;
    const controller = new AbortController();
    void loadExecution(target.taskId, target.executionId, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      const empty = t(value.execution.status === "failed" ? "tasks.emptyFailed"
        : value.execution.status === "stopped" ? "tasks.emptyStopped"
          : value.execution.status === "interrupted" ? "tasks.emptyInterrupted" : "tasks.emptyResult");
      setResult({ ...target, content: value.answer.trim() ? value.answer : empty });
    }).catch(cause => {
      if (!controller.signal.aborted) setResult({ ...target, error: cause instanceof ApiError && cause.status === 404
        ? t("tasks.missing") : errorMessage(cause, t("tasks.readFailed"), t) });
    });
    return () => controller.abort();
  }, [target?.taskId, target?.executionId, revision, t]);
  const current = result?.taskId === target?.taskId && result?.executionId === target?.executionId ? result : undefined;
  return <ContentPreviewPanel open={!!target} closeLabel={t("tasks.closePreview")} onClose={onClose}
    onRetry={() => setRevision(value => value + 1)} format="markdown" content={current?.content ?? ""} loading={!!target && !current} error={current?.error}
    testID="task-execution-preview-panel" scrollTestID="task-execution-preview-scroll" markdownTestID="task-execution-markdown-preview" />;
}
