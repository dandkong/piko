import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** One stored upload. The model reads `path`; channels share the same file. */
export type StoredAttachment = { id: string; path: string; mime: string; bytes: number };

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Extension hints, in both directions: a file keeps a recognizable suffix so the model can judge it. */
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp",
  "application/pdf": "pdf", "application/zip": "zip", "application/json": "json",
  "application/msword": "doc", "application/vnd.ms-excel": "xls", "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt", "text/markdown": "md", "text/csv": "csv", "text/html": "html", "text/xml": "xml",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
};
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/;

/** Sniff the formats both the model and the image processor accept; never trust a client-supplied type. */
export function detectAttachmentMimeType(bytes: Uint8Array): string | undefined {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (starts(0x42, 0x4d)) return "image/bmp";
  return undefined;
}

/**
 * Downloads and app uploads land here, outside the workspace: attachments are runtime data, not user content.
 * Names are server-generated, so a path never comes from a client.
 */
export class AttachmentStore {
  constructor(readonly directory: string, private readonly maxBytes = MAX_ATTACHMENT_BYTES) {}

  /** Any file is kept: the model decides how to inspect it. Only the suffix is taken from the name, never a path. */
  async save(input: { bytes: Uint8Array; name?: string; mime?: string }): Promise<StoredAttachment> {
    const { bytes } = input;
    if (!bytes.length) throw new Error("The attachment is empty.");
    if (bytes.length > this.maxBytes) throw new Error("The attachment is too large.");
    const detected = detectAttachmentMimeType(bytes);
    const extension = nameExtension(input.name) ?? (detected && MIME_EXTENSIONS[detected])
      ?? (input.mime && MIME_EXTENSIONS[input.mime]) ?? "bin";
    const id = `${randomUUID()}.${extension}`;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, id);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    return { id, path, mime: detected ?? input.mime ?? "application/octet-stream", bytes: bytes.length };
  }

  async read(id: string): Promise<{ attachment: StoredAttachment; bytes: Uint8Array } | undefined> {
    if (!ID.test(id)) return undefined;
    const path = join(this.directory, id);
    try {
      const bytes = new Uint8Array(await readFile(path));
      return { attachment: { id, path, mime: detectExtension(id), bytes: bytes.length }, bytes };
    } catch { return undefined; }
  }

  async lookup(id: string): Promise<StoredAttachment | undefined> {
    if (!ID.test(id)) return undefined;
    const path = join(this.directory, id);
    try {
      const info = await stat(path);
      return info.isFile() ? { id, path, mime: detectExtension(id), bytes: info.size } : undefined;
    } catch { return undefined; }
  }

  /** Paths already referenced by saved history stay readable until this age; long enough for follow-up turns. */
  async sweep(maxAgeMs: number, now = Date.now()): Promise<number> {
    let names: string[];
    try { names = await readdir(this.directory); } catch { return 0; }
    let removed = 0;
    for (const name of names) {
      if (!ID.test(name)) continue;
      const path = join(this.directory, name);
      try {
        if (now - (await stat(path)).mtimeMs < maxAgeMs) continue;
        await unlink(path); removed++;
      } catch { /* A concurrent sweep or a manual deletion is fine. */ }
    }
    return removed;
  }
}

function nameExtension(name: string | undefined): string | undefined {
  const value = name?.match(/\.([A-Za-z0-9]{1,8})$/)?.[1].toLowerCase();
  return value && /^[a-z0-9]+$/.test(value) ? value : undefined;
}

function detectExtension(id: string): string {
  const extension = id.slice(id.lastIndexOf(".") + 1);
  return Object.entries(MIME_EXTENSIONS).find(([, value]) => value === extension)?.[0] ?? "application/octet-stream";
}
