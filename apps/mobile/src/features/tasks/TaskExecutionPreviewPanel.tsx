import { useEffect, useState } from "react";
import { ContentPreviewPanel } from "../../components/ContentPreviewPanel";
import { loadExecution } from "./api";

export type TaskExecutionPreviewTarget = { taskId: string; executionId: string };

export function TaskExecutionPreviewPanel({ target, onClose }: {
  target?: TaskExecutionPreviewTarget;
  onClose: () => void;
}) {
  const [result, setResult] = useState<(TaskExecutionPreviewTarget & { content?: string; error?: string })>();
  useEffect(() => {
    setResult(undefined);
    if (!target) return;
    const controller = new AbortController();
    void loadExecution(target.taskId, target.executionId, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      const empty = value.execution.status === "failed" ? "本次执行失败，没有文字结果。"
        : value.execution.status === "stopped" ? "本次执行已停止，没有文字结果。"
          : value.execution.status === "interrupted" ? "本次执行已中断，没有文字结果。" : "本次执行没有文字结果。";
      setResult({ ...target, content: value.answer.trim() ? value.answer : empty });
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ ...target, error: "无法读取这次执行结果，请关闭后重试。" });
    });
    return () => controller.abort();
  }, [target?.taskId, target?.executionId]);
  const current = result?.taskId === target?.taskId && result?.executionId === target?.executionId ? result : undefined;
  return <ContentPreviewPanel open={!!target} closeLabel="关闭运行结果预览" onClose={onClose}
    format="markdown" content={current?.content ?? ""} loading={!!target && !current} error={current?.error}
    testID="task-execution-preview-panel" scrollTestID="task-execution-preview-scroll" markdownTestID="task-execution-markdown-preview" />;
}
