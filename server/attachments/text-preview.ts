import { artifactPreviewKind, decodePreviewText, MAX_ARTIFACT_PREVIEW_BYTES } from "../../shared/artifacts";
import { json } from "../http";

/** Reuse the artifact text policy; binary and large files remain downloadable. */
export function attachmentTextPreview(name: string, bytes: Uint8Array): Response {
  const preview = artifactPreviewKind(name);
  if (!preview) return json({ error: "This file type cannot be previewed." }, 415);
  if (bytes.byteLength > MAX_ARTIFACT_PREVIEW_BYTES) return json({ error: "File too large to preview." }, 413);
  return json({ content: decodePreviewText(bytes), preview });
}
