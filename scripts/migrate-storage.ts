import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, chmod, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Cursor, DocumentContent, DocumentCreate, DocumentId, Page, Seq, Storage, StorageWrite } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openRuntimeStorage, STORAGE_FILE } from "../server/runtime/storage";

type MainWrite = Exclude<StorageWrite, { type: "document.create" | "document.change" | "document.copy" }> |
  { type: "task.sidecar"; id: number; ordinal: number } |
  { type: "document.create"; record: DocumentCreate; ordinal: number } |
  { type: "document.change"; id: DocumentId; ordinal: number };
type Marker = { format: number; type: string; seq: Seq; writes: MainWrite[] };
type Sidecar = { format: number; type: string; seq: Seq; ordinal: number; payload:
  Extract<StorageWrite, { type: "task" }> | { type: "document"; id: DocumentId; content: DocumentContent } };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const key = (file: string, seq: number, ordinal: number) => `${file}:${seq}:${ordinal}`;
const lines = <T>(text: string): T[] => text.trim() ? text.trimEnd().split("\n").map(line => JSON.parse(line)) : [];
const currentOnly = (record: DocumentCreate) => record.scope.kind !== "conversation" || record.history === "latest";

async function collect<T>(scan: (cursor?: Cursor) => Promise<Page<T, Cursor>>) {
  const values: T[] = [];
  let cursor: Cursor | undefined;
  do { const page = await scan(cursor); values.push(...page.items); cursor = page.next; } while (cursor);
  return values;
}
function same(label: string, a: unknown, b: unknown) {
  if (!isDeepStrictEqual(a, b)) throw new Error(`Migration verification mismatch: ${label}`);
}

/** Compare public storage reads, including entry commit sequences and retained as-of documents. */
async function verify(source: Storage, target: Storage, markers: Marker[]) {
  const conversations = await collect(cursor => source.scanConversations({}, 500, cursor, ctx));
  same("conversations", conversations, await collect(cursor => target.scanConversations({}, 500, cursor, ctx)));
  const tasks = await collect(cursor => source.scanTasks({}, 500, cursor, ctx));
  same("tasks", tasks, await collect(cursor => target.scanTasks({}, 500, cursor, ctx)));
  const submissions = await collect(cursor => source.scanSubmissions({}, 500, cursor, ctx));
  same("submissions", submissions, await collect(cursor => target.scanSubmissions({}, 500, cursor, ctx)));
  const entries = new Set<Extract<StorageWrite, {type: "entry"}>["value"]["id"]>();
  const documents = new Map<DocumentId, { record: DocumentCreate; points: Set<Seq> }>();
  for (const marker of markers) for (const write of marker.writes) {
    if (write.type === "entry") entries.add(write.value.id);
    if (write.type === "document.create") documents.set(write.record.id, { record: write.record, points: new Set([marker.seq]) });
    if (write.type === "document.change") documents.get(write.id)!.points.add(marker.seq);
  }
  for (const id of entries) same(`entry ${id}`, await source.entry(id, ctx), await target.entry(id, ctx));
  for (const conversation of conversations) {
    const query = { conversationId: conversation.id, order: "ascending" as const };
    same(`visible history ${conversation.id}`, await collect(cursor => source.scanEntries(query, 500, cursor, ctx)),
      await collect(cursor => target.scanEntries(query, 500, cursor, ctx)));
  }
  let historicalPoints = 0;
  for (const [id, { record, points }] of documents) {
    same(`current document ${id}`, await source.document(id, "current", ctx), await target.document(id, "current", ctx));
    if (currentOnly(record)) continue;
    for (const seq of points) {
      same(`document ${id} at ${seq}`, await source.document(id, seq, ctx), await target.document(id, seq, ctx));
      historicalPoints++;
    }
  }
  return { conversations: conversations.length, entries: entries.size, tasks: tasks.length,
    submissions: submissions.length, documents: documents.size, historicalPoints, commits: markers.length };
}

/** Explicit offline format-v1 import. Never opens or edits the original JSONL with the SDK. */
export async function migrateStorage(from: string, to: string) {
  const sourceDirectory = resolve(from);
  const destination = resolve(to);
  if (!(await lstat(sourceDirectory)).isDirectory() || await realpath(sourceDirectory) !== sourceDirectory)
    throw new Error("Source must be a regular directory, not a symlink.");
  for (const name of await readdir(sourceDirectory)) {
    if (!(await lstat(join(sourceDirectory, name))).isFile())
      throw new Error("Source must contain only regular files, not links or subdirectories.");
  }
  if (destination === sourceDirectory || destination.startsWith(`${sourceDirectory}/`))
    throw new Error("Destination must be separate from the source directory.");
  if (existsSync(destination)) throw new Error("Destination already exists; refusing to overwrite it.");
  await mkdir(dirname(destination), { recursive: true });
  const temporary = await mkdtemp(join(dirname(destination), ".piko-migration-"));
  await chmod(temporary, 0o700);
  let source: Storage | undefined;
  let target: Storage | undefined;
  try {
    // Recovery may trim torn tails/reclaimed sidecars. It must only run on our private copy.
    const originalMain = await readFile(join(sourceDirectory, "main.jsonl"));
    const working = join(temporary, "source");
    await cp(sourceDirectory, working, { recursive: true, errorOnExist: true, force: false });
    if (digest(originalMain) !== digest(await readFile(join(sourceDirectory, "main.jsonl"))))
      throw new Error("Source changed during snapshot. Stop the writer and retry.");
    source = await openNodeJsonlStorage(working, ctx);
    const markers = lines<Marker>(await readFile(join(working, "main.jsonl"), "utf8"));
    if (!markers.length) throw new Error("Source has no committed state.");
    for (const [index, marker] of markers.entries())
      if (marker.format !== 1 || marker.type !== "commit" || marker.seq !== index + 1)
        throw new Error("Importer requires JSONL format 1 and contiguous commit sequences.");
    const records = new Map<string, Sidecar>();
    for (const file of await readdir(working)) {
      if (!/^(doc|task)-\d+\.jsonl$/.test(file)) continue;
      for (const record of lines<Sidecar>(await readFile(join(working, file), "utf8"))) {
        if (record.format !== 1 || record.type !== "record") throw new Error("Unsupported sidecar format.");
        records.set(key(file, record.seq, record.ordinal), record);
      }
    }
    // Match the native JSONL recovery contract: terminal-task checkpoints and
    // superseded current-only document revisions may already have been reclaimed.
    const liveTasks = new Map<number, boolean>();
    const latestDocuments = new Set<DocumentId>();
    const retired = new Set<DocumentId>();
    for (const marker of markers) for (const write of marker.writes) {
      if (write.type === "task") liveTasks.set(write.value.id, false);
      if (write.type === "task.sidecar") liveTasks.set(write.id, true);
      if (write.type === "document.create" && currentOnly(write.record)) latestDocuments.add(write.record.id);
      if (write.type === "document.retire") retired.add(write.id);
    }
    const latestBase = new Map<DocumentId, Sidecar>();
    for (const record of records.values()) {
      const payload = record.payload;
      if (payload.type === "document" && latestDocuments.has(payload.id) && payload.content.kind === "base") {
        const previous = latestBase.get(payload.id);
        if (!previous || record.seq > previous.seq || (record.seq === previous.seq && record.ordinal > previous.ordinal))
          latestBase.set(payload.id, record);
      }
    }
    const output = join(temporary, "output");
    // The unpublished staging DB is reproducible from the untouched source, so use
    // the native adapter's NORMAL durability during import rather than fsync 40k+
    // commits individually. Close/checkpoint and verify again before publication.
    target = await SqliteStorage.open(await openNodeSqliteDatabase(join(output, STORAGE_FILE)));
    for (const marker of markers) {
      const writes: StorageWrite[] = [];
      for (const write of marker.writes) {
        if (write.type === "task.sidecar") {
          if (!liveTasks.get(write.id)) continue;
          const record = records.get(key(`task-${write.id}.jsonl`, marker.seq, write.ordinal));
          if (record?.payload.type !== "task" || record.payload.value.id !== write.id)
            throw new Error(`Missing live task sidecar at commit ${marker.seq}`);
          writes.push(record.payload);
        } else if (write.type === "document.create" || write.type === "document.change") {
          const id = write.type === "document.create" ? write.record.id : write.id;
          const base = latestBase.get(id);
          const reclaimed = latestDocuments.has(id) && (retired.has(id) || !!base &&
            (marker.seq < base.seq || marker.seq === base.seq && write.ordinal < base.ordinal));
          const record = records.get(key(`doc-${id}.jsonl`, marker.seq, write.ordinal));
          const content = record?.payload.type === "document" && record.payload.id === id ? record.payload.content : undefined;
          if (!reclaimed && !content) throw new Error(`Missing document sidecar at commit ${marker.seq}`);
          if (write.type === "document.create") {
            const initial = reclaimed ? { kind: "base" as const, version: 1, value: {} } : content!;
            if (initial.kind !== "base") throw new Error("Document creation must contain a base.");
            writes.push({ type: "document.create", record: write.record, content: initial });
          } else if (!reclaimed) writes.push({ type: "document.change", id, content: content! });
        } else writes.push(write);
      }
      const seq = await target.commit(writes, ctx);
      if (seq !== marker.seq) throw new Error("Commit sequence changed during migration.");
      if (Number(seq) % 10000 === 0) console.error(`Verified replay progress: ${seq}/${markers.length} commits`);
    }
    const counts = await verify(source, target, markers);
    await target.close(ctx);
    target = undefined;
    // Verification must also succeed after closing/checkpointing and reopening SQLite.
    target = (await openRuntimeStorage(output)).storage;
    same("reopened counts", counts, await verify(source, target, markers));
    await target.close(ctx); target = undefined;
    await chmod(join(output, STORAGE_FILE), 0o600);
    await chmod(output, 0o700);
    await writeFile(join(output, "migration.json"), JSON.stringify({ format: 1, source: "Durable JSONL v1",
      sourceMainSha256: digest(originalMain), migratedAt: new Date().toISOString(), counts }, null, 2) + "\n", { mode: 0o600 });
    await rename(output, destination);
    return { destination, ...counts };
  } finally {
    await target?.close(ctx);
    await source?.close(ctx);
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [from, to, ...extra] = process.argv.slice(2);
  if (!from || !to || extra.length) throw new Error("Usage: bun scripts/migrate-storage.ts <source-jsonl-directory> <new-sqlite-directory>");
  console.log(JSON.stringify(await migrateStorage(from, to), null, 2));
}
