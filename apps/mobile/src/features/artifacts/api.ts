import type { ArtifactDeletion, ArtifactDirectory, ArtifactTextPreview } from "../../../../../shared/artifacts";
import { API_URL, apiFetch, readJson } from "../../api/client";

function pathQuery(path: string) {
  return `?path=${encodeURIComponent(path)}`;
}

export async function loadArtifacts(path: string, signal?: AbortSignal): Promise<ArtifactDirectory> {
  return readJson<ArtifactDirectory>(await apiFetch(`/api/artifacts${path ? pathQuery(path) : ""}`, { signal }));
}

export async function loadArtifactPreview(path: string, signal?: AbortSignal): Promise<ArtifactTextPreview> {
  return readJson<ArtifactTextPreview>(await apiFetch(`/api/artifacts/content${pathQuery(path)}`, { signal }));
}

export async function deleteArtifact(path: string): Promise<ArtifactDeletion> {
  return readJson<ArtifactDeletion>(await apiFetch(`/api/artifacts${pathQuery(path)}`, { method: "DELETE", timeoutMs: 120_000 }));
}

export function artifactDownloadUrl(path: string) {
  return `${API_URL}/api/artifacts/download${pathQuery(path)}`;
}
