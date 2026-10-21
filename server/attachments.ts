import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

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
 * Files keep the name they arrived with; a repeated name overwrites the earlier file. Only the last path segment is
 * used, so a client can never choose a directory, and control characters are dropped.
 */
export function safeAttachmentName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  let value = basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!value || value === "." || value === "..") return undefined;
  // Filesystems cap a single name; keep the extension when trimming bytes.
  if (Buffer.byteLength(value) > 200) {
    const dot = value.lastIndexOf(".");
    const suffix = dot > 0 ? value.slice(dot) : "";
    let head = dot > 0 ? value.slice(0, dot) : value;
    while (head && Buffer.byteLength(head + suffix) > 200) head = head.slice(0, -1);
    value = head + suffix;
  }
  return value;
}

/** Downloads and app uploads land here, outside the workspace: attachments are runtime data, not user content. */
export class AttachmentStore {
  constructor(readonly directory: string, private readonly maxBytes = MAX_ATTACHMENT_BYTES) {}

  /** Any file is kept under its own name; the model decides how to inspect it. */
  async save(input: { bytes: Uint8Array; name?: string; mime?: string }): Promise<StoredAttachment> {
    const { bytes } = input;
    if (!bytes.length) throw new Error("The attachment is empty.");
    if (bytes.length > this.maxBytes) throw new Error("The attachment is too large.");
    const detected = detectAttachmentMimeType(bytes);
    const extension = nameExtension(input.name) ?? (detected && MIME_EXTENSIONS[detected]) ?? (input.mime && MIME_EXTENSIONS[input.mime]) ?? "bin";
    const id = withExtension(safeAttachmentName(input.name) ?? randomUUID(), extension);
    const fromExtension = detectExtension(id);
    const mime = detected ?? (fromExtension !== "application/octet-stream" ? fromExtension : input.mime ?? "application/octet-stream");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.pathOf(id);
    await writeFile(path, bytes, { mode: 0o600 });
    return { id, path, mime, bytes: bytes.length };
  }

  async read(id: string): Promise<{ attachment: StoredAttachment; bytes: Uint8Array } | undefined> {
    if (!this.allowed(id)) return undefined;
    const path = this.pathOf(id);
    try {
      const bytes = new Uint8Array(await readFile(path));
      return { attachment: { id, path, mime: detectExtension(id), bytes: bytes.length }, bytes };
    } catch { return undefined; }
  }

  async lookup(id: string): Promise<StoredAttachment | undefined> {
    if (!this.allowed(id)) return undefined;
    const path = this.pathOf(id);
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
      if (!this.allowed(name)) continue;
      const path = this.pathOf(name);
      try {
        const info = await stat(path);
        if (!info.isFile() || now - info.mtimeMs < maxAgeMs) continue;
        await unlink(path); removed++;
      } catch { /* A concurrent sweep or a manual deletion is fine. */ }
    }
    return removed;
  }

  private pathOf(id: string): string {
    return join(this.directory, id);
  }

  private allowed(id: string): boolean {
    return safeAttachmentName(id) === id && resolve(this.pathOf(id)).startsWith(resolve(this.directory) + sep);
  }
}

function nameExtension(name: string | undefined): string | undefined {
  const value = name?.match(/\.([A-Za-z0-9]{1,8})$/)?.[1].toLowerCase();
  return value && /^[a-z0-9]+$/.test(value) ? value : undefined;
}

function withExtension(name: string, extension: string): string {
  return nameExtension(name) ? name : `${name}.${extension}`;
}

export function detectExtension(id: string): string {
  const extension = id.slice(id.lastIndexOf(".") + 1).toLowerCase();
  return Object.entries(MIME_EXTENSIONS).find(([, value]) => value === extension)?.[0] ?? "application/octet-stream";
}
