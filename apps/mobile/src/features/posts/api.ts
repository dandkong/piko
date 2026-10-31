import type { Post, PostGeneration, PostPage } from "../../../../../shared/posts";
import { apiFetch, readJson } from "../../api/client";
import { createUuidV4 } from "../../utils/uuid";

export async function loadPosts(before?: string, signal?: AbortSignal): Promise<PostPage> {
  return readJson<PostPage>(await apiFetch(`/api/posts${before ? `?before=${encodeURIComponent(before)}` : ""}`, { signal }));
}
export async function loadPost(id: string, signal?: AbortSignal): Promise<Post> {
  return readJson<Post>(await apiFetch(`/api/posts/${encodeURIComponent(id)}`, { signal }));
}
export async function loadPostGeneration(id: string, signal?: AbortSignal): Promise<PostGeneration> {
  return readJson<PostGeneration>(await apiFetch(`/api/posts/generations/${encodeURIComponent(id)}`, { signal }));
}
export async function deletePost(id: string): Promise<void> {
  const response = await apiFetch(`/api/posts/${encodeURIComponent(id)}`, { method: "DELETE", timeoutMs: 120_000 });
  if (!response.ok) await readJson<never>(response);
}
export async function generatePost(signal?: AbortSignal, requestId = createUuidV4()): Promise<PostGeneration> {
  return readJson<PostGeneration>(await apiFetch("/api/posts/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId }),
    signal,
  }));
}
