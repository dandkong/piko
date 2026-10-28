import type { Post, PostPage } from "../../../../../shared/posts";
import { apiFetch, readJson } from "../../api/client";

export async function loadPosts(before?: string, signal?: AbortSignal): Promise<PostPage> {
  return readJson<PostPage>(await apiFetch(`/api/posts${before ? `?before=${encodeURIComponent(before)}` : ""}`, { signal }));
}
export async function loadPost(id: string, signal?: AbortSignal): Promise<Post> {
  return readJson<Post>(await apiFetch(`/api/posts/${encodeURIComponent(id)}`, { signal }));
}
