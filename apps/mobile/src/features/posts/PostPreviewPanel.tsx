import { useEffect, useState } from "react";
import type { PostSummary } from "../../../../../shared/posts";
import { ContentPreviewPanel } from "../../components/ContentPreviewPanel";
import { loadPost } from "./api";

export function PostPreviewPanel({ post, onClose }: { post?: PostSummary; onClose: () => void }) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setContent(""); setError("");
    if (!post) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    void loadPost(post.id, controller.signal).then(value => {
      if (!controller.signal.aborted) setContent(value.body);
    }).catch(() => {
      if (!controller.signal.aborted) setError("无法读取这篇帖子，请关闭后重试。");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [post?.id]);
  return <ContentPreviewPanel open={!!post} title="帖子" closeLabel="关闭帖子预览" onClose={onClose}
    preview="markdown" content={content} loading={loading} error={error} testID="post-preview-panel"
    scrollTestID="post-preview-scroll" markdownTestID="post-markdown-preview" />;
}
