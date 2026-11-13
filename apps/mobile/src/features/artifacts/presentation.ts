import type { ArtifactEntry } from "../../../../../shared/artifacts";

export const artifactSortOptions = [
  { value: "name-asc", label: "artifacts.sortNameAsc" },
  { value: "name-desc", label: "artifacts.sortNameDesc" },
  { value: "modified-desc", label: "artifacts.sortTimeDesc" },
  { value: "modified-asc", label: "artifacts.sortTimeAsc" },
] as const;
export type ArtifactSort = typeof artifactSortOptions[number]["value"];
export const DEFAULT_ARTIFACT_SORT: ArtifactSort = "modified-desc";

export function isArtifactSort(value: unknown): value is ArtifactSort {
  return artifactSortOptions.some(option => option.value === value);
}

const names = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
export function sortArtifacts(entries: readonly ArtifactEntry[], sort: ArtifactSort): ArtifactEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    const nameOrder = names.compare(a.name, b.name);
    const stableNameOrder = nameOrder || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (sort === "name-asc") return stableNameOrder;
    if (sort === "name-desc") return -stableNameOrder;
    const timeOrder = a.modifiedAt - b.modifiedAt;
    return (sort === "modified-desc" ? -timeOrder : timeOrder) || stableNameOrder;
  });
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function artifactMetadata(entry: ArtifactEntry, now = new Date(), locale = "zh-CN"): string {
  const date = new Date(entry.modifiedAt);
  const time = date.toLocaleString(locale, {
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return entry.kind === "file" && entry.size !== null ? `${time} · ${fileSize(entry.size)}` : time;
}
