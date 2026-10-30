import type { Post, PostGeneration, PostPage } from "../../../../../shared/posts";
import { apiFetch, readJson } from "../../api/client";
import { createUuidV4 } from "../../utils/uuid";

export async function loadPosts(before?: string, signal?: AbortSignal): Promise<PostPage> {
  return readJson<PostPage>(await apiFetch(`/api/posts${before ? `?before=${encodeURIComponent(before)}` : ""}`, { signal }));
}
export async function loadPost(id: string, signal?: AbortSignal): Promise<Post> {
  return readJson<Post>(await apiFetch(`/api/posts/${encodeURIComponent(id)}`, { signal }));
}
export async function generatePost(signal?: AbortSignal): Promise<PostGeneration> {
  return readJson<PostGeneration>(await apiFetch("/api/posts/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: createUuidV4() }),
    signal,
  }));
}
