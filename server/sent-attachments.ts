import { constants } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_ATTACHMENT_BYTES, detectExtension, safeAttachmentName } from "./attachments";

/** Outgoing snapshots are separate from incoming attachments and have no automatic expiry. */
export class SentAttachmentStore {
  constructor(readonly directory: string) {}

  async save(source: string): Promise<{ id: string; name: string; mime: string; bytes: number }> {
    const name = safeAttachmentName(basename(source)) ?? "attachment";
    // Open without following the final symlink; O_NONBLOCK prevents waiting on a FIFO.
    const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error("The attachment must be a regular file.");
      if (!info.size || info.size > MAX_ATTACHMENT_BYTES) throw new Error("The attachment is empty or too large (maximum 20 MiB).");
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_ATTACHMENT_BYTES + 1 - total));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > MAX_ATTACHMENT_BYTES) throw new Error("The attachment is too large (maximum 20 MiB).");
        chunks.push(chunk.subarray(0, bytesRead));
      }
      bytes = Buffer.concat(chunks, total);
      if (!bytes.length) throw new Error("The attachment is empty.");
    } finally { await file.close(); }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const destination = join(this.directory, id);
    const output = await open(destination, "wx", 0o600);
    try {
      await output.writeFile(bytes);
      await output.sync();
    } catch (error) {
      await output.close().catch(() => {});
      await unlink(destination).catch(() => {});
      throw error;
    }
    await output.close();
    return { id, name, mime: detectExtension(name), bytes: bytes.length };
  }

  async read(id: string): Promise<Uint8Array | undefined> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return undefined;
    try { return await readFile(join(this.directory, id)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async discard(id: string): Promise<void> {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
      await unlink(join(this.directory, id)).catch(() => {});
  }
}
