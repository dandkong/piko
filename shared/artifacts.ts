export type ArtifactPreviewKind = "markdown" | "text";

export type ArtifactEntry = {
  name: string;
  path: string;
  kind: "directory" | "file";
  size: number | null;
  modifiedAt: number;
  preview: ArtifactPreviewKind | null;
};

export type ArtifactDirectory = {
  path: string;
  entries: ArtifactEntry[];
};

export type ArtifactTextPreview = {
  path: string;
  content: string;
  size: number;
  modifiedAt: number;
  preview: ArtifactPreviewKind;
};

export type ArtifactDeletion = {
  path: string;
  kind: "directory" | "file";
};

/** Keep in-app text previews bounded; larger files remain downloadable. */
export const MAX_ARTIFACT_PREVIEW_BYTES = 1024 * 1024;

const markdownExtensions = new Set(["md", "markdown"]);
const textExtensions = new Set([
  "txt", "text", "log", "json", "jsonl", "ndjson", "csv", "tsv",
  "yaml", "yml", "toml", "xml", "ini", "conf", "properties",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "sh", "bash", "zsh",
  "css", "html", "sql", "go", "rs", "java", "c", "h", "cc", "cpp",
  "hpp", "cs", "php", "rb", "swift", "kt", "vue", "svelte", "svg",
]);
const wellKnownTextNames = new Set(["readme", "license", "notice", "changelog"]);

export function artifactPreviewKind(name: string): ArtifactPreviewKind | null {
  const lower = name.toLowerCase();
  if (wellKnownTextNames.has(lower)) return "text";
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  const extension = lower.slice(dot + 1);
  if (markdownExtensions.has(extension)) return "markdown";
  return textExtensions.has(extension) ? "text" : null;
}
