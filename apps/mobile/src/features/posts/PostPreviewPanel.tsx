import { useEffect, useState } from "react";
import type { PostSummary } from "../../../../../shared/posts";
import { ContentPreviewPanel } from "../../components/ContentPreviewPanel";
import { loadPost } from "./api";
import { PostActions } from "./PostActions";

export function PostPreviewPanel({ post, onClose, onDeleted }: { post?: PostSummary; onClose: () => void; onDeleted: (id: string) => void }) {
  const [result, setResult] = useState<{ id: string; content?: string; error?: string }>();
  useEffect(() => {
    setResult(undefined);
    if (!post) return;
    const controller = new AbortController();
    void loadPost(post.id, controller.signal).then(value => {
      if (!controller.signal.aborted) setResult({ id: post.id, content: value.body });
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ id: post.id, error: "无法读取这篇帖子，请关闭后重试。" });
    });
    return () => controller.abort();
  }, [post?.id]);
  const current = result?.id === post?.id ? result : undefined;
  return <ContentPreviewPanel open={!!post} title={post?.title} closeLabel="关闭帖子预览" onClose={onClose}
    format="markdown" content={current?.content ?? ""} loading={!!post && !current} error={current?.error}
    headerActions={post && <PostActions key={post.id} post={post} onDeleted={onDeleted} />}
    testID="post-preview-panel" scrollTestID="post-preview-scroll" markdownTestID="post-markdown-preview" />;
}
