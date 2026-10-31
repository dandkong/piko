import { useEffect, useState } from "react";
import type { PostSummary } from "../../../../../shared/posts";
import { ContentPreviewPanel } from "../../components/ContentPreviewPanel";
import { loadPost } from "./api";
import { ApiError, errorMessage } from "../../api/errors";

export function PostPreviewPanel({ post, onClose }: { post?: PostSummary; onClose: () => void }) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ id: string; content?: string; error?: string }>();
  useEffect(() => {
    setResult(undefined);
    if (!post) return;
    const controller = new AbortController();
    void loadPost(post.id, controller.signal).then(value => {
      if (!controller.signal.aborted) setResult({ id: post.id, content: value.body });
    }).catch(cause => {
      if (!controller.signal.aborted) setResult({ id: post.id, error: cause instanceof ApiError && cause.status === 404
        ? "这篇帖子已不存在。请关闭预览并刷新列表。" : errorMessage(cause, "无法读取这篇帖子，请重新加载。") });
    });
    return () => controller.abort();
  }, [post?.id, revision]);
  const current = result?.id === post?.id ? result : undefined;
  return <ContentPreviewPanel open={!!post} title={post?.title} closeLabel="关闭帖子预览" onClose={onClose}
    onRetry={() => setRevision(value => value + 1)} format="markdown" content={current?.content ?? ""} loading={!!post && !current} error={current?.error}
    testID="post-preview-panel" scrollTestID="post-preview-scroll" markdownTestID="post-markdown-preview" />;
}
