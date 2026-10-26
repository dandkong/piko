import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, ROOT_CONVERSATION_ID, type DocumentRecord, type Harness, type Storage, type Tx } from "@earendil-works/pi-durable";
import { CURRENT_SQLITE_SCHEMA_VERSION, type SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { AssistantTaskError } from "../domain/tasks";
import { ANCHOR_KIND, REPORTER_KIND } from "./subagents/documents";
import { SideChatError } from "./side-chats";

const StorageCleanup = defineDoc<{ required: boolean }>({
  kind: "piko.storage-cleanup", version: 1, scope: "session", initial: () => ({ required: false }),
  checkpointWhen: () => false,
});

export type SideChatDeletion = {
  id: number;
  conversations: number[];
  tasks: number[];
  documents: DocumentRecord[];
  retired: boolean;
};
export type TaskStorageDeletion = {
  taskId: string;
  conversations: number[];
  tasks: number[];
  documents: DocumentRecord[];
};

/** Piko maintenance over the SAME native database. Call planning/purge on the Harness
 * mutation line; stop and drain the ownership subtree, then retire native documents
 * through Tx before physical deletion so Session observers/caches cannot retain them.
 * No files, attachments, backups or unrelated conversation records are touched. */
export class StorageMaintenance {
  constructor(private readonly database: SqliteDatabase, private readonly storage: Storage) {}

  async planSideChat(value: string): Promise<SideChatDeletion> {
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) === 1)
      throw new SideChatError("Side chat not found.");
    const id = Number(value);
    const schema = await this.database.get<{version: number}>("SELECT version FROM durable_schema WHERE singleton=1");
    if (schema?.version !== CURRENT_SQLITE_SCHEMA_VERSION) throw new Error("Unsupported Durable schema for permanent deletion.");
    const conversations = await this.database.all<{id: number; owner_conversation_id: number | null; owner_task_id: number | null; parent: number | null}>(
      "SELECT id,owner_conversation_id,owner_task_id,json_extract(record,'$.parent.conversationId') AS parent FROM conversations");
    const owner = conversations.find(row => row.id === id);
    if (!owner || owner.owner_conversation_id !== null || owner.owner_task_id !== null)
      throw new SideChatError("Side chat not found.");
    const markers = await this.database.all<{record: string}>(
      "SELECT record FROM documents WHERE scope_kind='conversation' AND owner_id=? AND kind=?", id, JSON.stringify("piko.side-chat"));
    const records = markers.map(row => JSON.parse(row.record) as DocumentRecord);
    const active = records.find(row => row.retiredAt === undefined);
    const metadata = active ? await this.storage.document(active.id, "current", ctx) : undefined;
    const retired = !metadata?.value.createdAt && records.some(row => row.retiredAt !== undefined);
    if (!metadata?.value.createdAt && !retired) throw new SideChatError("Side chat not found.");
    const tasks = await this.database.all<{id: number; conversation_id: number; owner: number | null}>(
      "SELECT id,conversation_id,json_extract(record,'$.owner') AS owner FROM tasks");
    const cs = new Set([id]), ts = new Set<number>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks) if (!ts.has(task.id) && (cs.has(task.conversation_id) || task.owner !== null && ts.has(task.owner))) {
        ts.add(task.id); changed = true;
      }
      for (const row of conversations) if (!cs.has(row.id) &&
        (row.owner_conversation_id !== null && cs.has(row.owner_conversation_id) || row.owner_task_id !== null && ts.has(row.owner_task_id))) {
        cs.add(row.id); changed = true;
      }
    }
    if (cs.has(1)) throw new Error("Refusing to include the root conversation in a side-chat deletion.");
    if (conversations.some(row => !cs.has(row.id) && row.parent !== null && cs.has(row.parent)))
      throw new SideChatError("Another conversation inherits this history; deletion requires an explicit fork policy.", 409);
    const documents: DocumentRecord[] = [];
    for (const row of await this.database.all<{record: string}>("SELECT record FROM documents")) {
      const record = JSON.parse(row.record) as DocumentRecord;
      if (record.scope.kind === "conversation" && cs.has(record.scope.conversationId) ||
        record.scope.kind === "task" && ts.has(record.scope.taskId)) documents.push(record);
      else if (record.scope.kind === "session" && record.kind === "piko.side-chat-creates") {
        // Retired creation receipts have no live value; they can remain after an
        // interrupted purge, and no other feature retires these receipts.
        if (record.retiredAt !== undefined) { documents.push(record); continue; }
        const receipt = await this.storage.document(record.id, "current", ctx);
        if (typeof receipt?.value.conversationId === "number" && cs.has(receipt.value.conversationId)) documents.push(record);
      }
    }
    return { id, conversations: [...cs], tasks: [...ts], documents, retired };
  }

  async planTask(
    taskId: string,
    executionConversations: readonly number[],
    preserveRequestId: string,
  ): Promise<TaskStorageDeletion> {
    const schema = await this.database.get<{version: number}>("SELECT version FROM durable_schema WHERE singleton=1");
    if (schema?.version !== CURRENT_SQLITE_SCHEMA_VERSION) throw new Error("Unsupported Durable schema for permanent deletion.");
    const conversations = await this.database.all<{id: number; owner_conversation_id: number | null; owner_task_id: number | null; parent: number | null}>(
      "SELECT id,owner_conversation_id,owner_task_id,json_extract(record,'$.parent.conversationId') AS parent FROM conversations");
    const nativeTasks = await this.database.all<{id: number; conversation_id: number; owner: number | null; status: string; record: string}>(
      "SELECT id,conversation_id,json_extract(record,'$.owner') AS owner,status,record FROM tasks");
    const cs = new Set(executionConversations);
    const seed = new Set(executionConversations);
    const ts = new Set<number>();
    for (const row of nativeTasks) {
      const record = JSON.parse(row.record) as {kind?: string; input?: {child?: unknown}};
      if (row.conversation_id !== ROOT_CONVERSATION_ID) continue;
      if (record.kind === ANCHOR_KIND && conversations.some(conversation =>
        seed.has(conversation.id) && conversation.owner_task_id === row.id))
        ts.add(row.id);
      if (record.kind === REPORTER_KIND && Number.isSafeInteger(Number(record.input?.child)) &&
        seed.has(Number(record.input?.child))) ts.add(row.id);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of nativeTasks) if (!ts.has(task.id) &&
        (cs.has(task.conversation_id) || task.owner !== null && ts.has(task.owner))) {
        ts.add(task.id);
        changed = true;
      }
      for (const conversation of conversations) if (!cs.has(conversation.id) &&
        (conversation.owner_conversation_id !== null && cs.has(conversation.owner_conversation_id) ||
          conversation.owner_task_id !== null && ts.has(conversation.owner_task_id))) {
        cs.add(conversation.id);
        changed = true;
      }
    }
    if (cs.has(ROOT_CONVERSATION_ID)) throw new Error("Refusing to include the root conversation in a task deletion.");
    if (conversations.some(row => !cs.has(row.id) && row.parent !== null && cs.has(row.parent)))
      throw new AssistantTaskError("Another conversation inherits this execution history; deletion is unsafe.", 409);
    if (nativeTasks.some(row => ts.has(row.id) && row.status !== "terminal"))
      throw new AssistantTaskError("The task still has running work. Stop it and retry deletion.", 409);

    const documents: DocumentRecord[] = [];
    for (const row of await this.database.all<{record: string}>("SELECT record FROM documents")) {
      const record = JSON.parse(row.record) as DocumentRecord;
      if (record.scope.kind === "conversation" && cs.has(record.scope.conversationId) ||
        record.scope.kind === "task" && ts.has(record.scope.taskId)) {
        documents.push(record);
        continue;
      }
      if (record.kind === "piko.tasks" && record.scope.kind === "conversation" &&
        record.scope.conversationId === ROOT_CONVERSATION_ID && record.retiredAt !== undefined) {
        documents.push(record);
        continue;
      }
      // Retired/empty command receipts are stale; remove live receipts for this task.
      // Keep the deletion receipt for safe retries.
      if (record.kind !== "piko.task-command" || record.scope.kind !== "conversation" ||
        record.scope.conversationId !== ROOT_CONVERSATION_ID || record.key === preserveRequestId) continue;
      if (record.retiredAt !== undefined) {
        documents.push(record);
        continue;
      }
      const receipt = await this.storage.document(record.id, "current", ctx);
      if (receipt?.value.id === taskId ||
        receipt?.value.hash === "" && receipt.value.id === "") documents.push(record);
    }
    return { taskId, conversations: [...cs], tasks: [...ts], documents };
  }

  async purgeTask(plan: TaskStorageDeletion) {
    await this.database.transaction(async tx => {
      if (plan.tasks.length) {
        const placeholders = plan.tasks.map(() => "?").join(",");
        const running = await tx.get<{n: number}>(`SELECT count(*) AS n FROM tasks WHERE id IN (${placeholders}) AND status!='terminal'`, ...plan.tasks);
        if (running?.n) throw new AssistantTaskError("The task still has running work. Stop it and retry deletion.", 409);
      }
      for (const document of plan.documents) {
        const row = await tx.get<{retired_at: number | null}>("SELECT retired_at FROM documents WHERE id=?", document.id);
        if (row?.retired_at === null) throw new Error("Native documents must be retired before purging their storage.");
      }
      for (const id of plan.conversations) {
        await tx.run("DELETE FROM record_ids WHERE id IN (SELECT id FROM entries WHERE conversation_id=? UNION SELECT id FROM submissions WHERE conversation_id=?)", id, id);
        await tx.run("DELETE FROM entries WHERE conversation_id=?", id);
        await tx.run("DELETE FROM submissions WHERE conversation_id=?", id);
        await tx.run("DELETE FROM conversations WHERE id=?", id);
        await tx.run("DELETE FROM record_ids WHERE id=?", id);
      }
      for (const id of plan.tasks) {
        await tx.run("DELETE FROM tasks WHERE id=?", id);
        await tx.run("DELETE FROM record_ids WHERE id=?", id);
      }
      for (const document of plan.documents) {
        await tx.run("DELETE FROM document_revisions WHERE document_id=?", document.id);
        await tx.run("DELETE FROM documents WHERE id=?", document.id);
        await tx.run("DELETE FROM record_ids WHERE id=?", document.id);
      }
    });
  }

  async purge(plan: SideChatDeletion) {
    await this.database.transaction(async tx => {
      const placeholders = plan.conversations.map(() => "?").join(",");
      const running = await tx.get<{n: number}>(`SELECT count(*) AS n FROM tasks WHERE conversation_id IN (${placeholders}) AND status!='terminal'`, ...plan.conversations);
      if (running?.n) throw new SideChatError("The side chat still has running work. Retry deletion after it stops.", 409);
      for (const document of plan.documents) {
        const row = await tx.get<{retired_at: number | null}>("SELECT retired_at FROM documents WHERE id=?", document.id);
        if (row?.retired_at === null) throw new Error("Native documents must be retired before purging their storage.");
      }
      // Keep next_id/next_seq monotonic; removed IDs are never allocated again.
      for (const id of plan.conversations) {
        await tx.run("DELETE FROM record_ids WHERE id IN (SELECT id FROM entries WHERE conversation_id=? UNION SELECT id FROM submissions WHERE conversation_id=?)", id, id);
        await tx.run("DELETE FROM entries WHERE conversation_id=?", id);
        await tx.run("DELETE FROM submissions WHERE conversation_id=?", id);
        await tx.run("DELETE FROM conversations WHERE id=?", id);
        await tx.run("DELETE FROM record_ids WHERE id=?", id);
      }
      for (const id of plan.tasks) {
        await tx.run("DELETE FROM tasks WHERE id=?", id);
        await tx.run("DELETE FROM record_ids WHERE id=?", id);
      }
      for (const document of plan.documents) {
        await tx.run("DELETE FROM document_revisions WHERE document_id=?", document.id);
        await tx.run("DELETE FROM documents WHERE id=?", document.id);
        await tx.run("DELETE FROM record_ids WHERE id=?", document.id);
      }
    });
  }

  async erase(harness: Harness, value: string) {
    const plan = await harness.commit(() => this.planSideChat(value), ctx);
    await harness.commit(async tx => {
      (await tx.doc(StorageCleanup)).required = true;
      for (const document of plan.documents) await retireDocument(tx, document);
    }, ctx);
    await harness.commit(() => this.purge(plan), ctx);
  }

  async eraseTask(
    harness: Harness,
    taskId: string,
    executionConversations: readonly number[],
    preserveRequestId: string,
  ) {
    const plan = await harness.commit(
      () => this.planTask(taskId, executionConversations, preserveRequestId),
      ctx,
    );
    await harness.commit(async tx => {
      (await tx.doc(StorageCleanup)).required = true;
      for (const document of plan.documents) await retireDocument(tx, document);
    }, ctx);
    await harness.commit(() => this.purgeTask(plan), ctx);
  }

  /** Native retirements are the durable intent: finish an interrupted purge before
   * resume. A content-free flag also covers a crash after DELETE but before WAL cleanup. */
  async recover(harness: Harness) {
    const pending = await this.database.all<{id: number}>(
      "SELECT DISTINCT c.id FROM conversations c JOIN documents d ON d.scope_kind='conversation' AND d.owner_id=c.id WHERE c.id!=1 AND c.owner_conversation_id IS NULL AND c.owner_task_id IS NULL AND d.kind=? AND d.retired_at IS NOT NULL", JSON.stringify("piko.side-chat"));
    for (const row of pending) await this.erase(harness, String(row.id));
    if (pending.length || (await harness.snapshot(StorageCleanup, ctx))?.required) await this.compact(harness);
  }

  async compactIfRequired(harness: Harness) {
    if ((await harness.snapshot(StorageCleanup, ctx))?.required)
      await this.compact(harness);
  }

  /** A failed checkpoint is reported, never silently described as complete erasure. */
  async compact(harness: Harness) {
    const checkpoint = async () => {
      const rows = await this.database.all<{busy: number}>("PRAGMA wal_checkpoint(TRUNCATE)");
      if (rows.some(row => row.busy)) throw new Error("Database checkpoint is busy; retry deletion to finish storage cleanup.");
    };
    await checkpoint();
    await this.database.exec("VACUUM");
    await checkpoint();
    await harness.commit(async tx => { (await tx.doc(StorageCleanup)).required = false; }, ctx);
  }
}

/** Retirement is native: it evicts Session trackers and notifies observers. The
 * definition's initial value/version are never acquired during retireDoc. */
export async function retireDocument(tx: Tx, record: DocumentRecord) {
  if (record.retiredAt !== undefined) return;
  const definition = { kind: record.kind, version: 1, checkpointWhen: () => false };
  const key = record.key;
  if (record.scope.kind === "session") {
    if (key === undefined) await tx.retireDoc(defineDoc({ ...definition, scope: "session", initial: () => ({}) }));
    else await tx.retireDoc(defineDocFamily({ ...definition, scope: "session", family: true, initial: () => ({}) }), key);
  } else if (record.scope.kind === "task") {
    if (key === undefined) await tx.retireDoc(defineDoc({ ...definition, scope: "task", initial: () => ({}) }), record.scope.taskId);
    else await tx.retireDoc(defineDocFamily({ ...definition, scope: "task", family: true, initial: () => ({}) }), record.scope.taskId, key);
  } else if (record.history === "latest") {
    const options = { ...definition, scope: "conversation" as const, history: "latest" as const, fork: record.fork };
    if (key === undefined) await tx.retireDoc(defineDoc({ ...options, initial: () => ({}) }), record.scope.conversationId);
    else await tx.retireDoc(defineDocFamily({ ...options, family: true, initial: () => ({}) }), record.scope.conversationId, key);
  } else {
    const options = { ...definition, scope: "conversation" as const, history: "rewindable" as const, fork: record.fork ?? "initial" };
    if (key === undefined) await tx.retireDoc(defineDoc({ ...options, initial: () => ({}) }), record.scope.conversationId);
    else await tx.retireDoc(defineDocFamily({ ...options, family: true, initial: () => ({}) }), record.scope.conversationId, key);
  }
}
