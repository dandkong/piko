import { lstat, readdir, realpath, rename, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  AgentDoc,
  defineDoc,
  defineDocFamily,
  type ConversationId,
  type Cursor,
  type DocumentRecord,
  type Harness,
  type Storage,
} from "@earendil-works/pi-durable";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { isWithin } from "../../workspace";
import { TaskContext, type TaskBinding } from "./context";
import { Receipts, TaskDefinitions, type StoredTask } from "./documents";

type CommandReceipt = { hash: string; id: string; executionId: string | null };
type LegacyTaskBinding = Omit<TaskBinding, "taskId"> & { itemId: string };

// These definitions are migration inputs only. New runtime state uses the task-named definitions below.
const LegacyTaskDefinitions = defineDoc<{ items: StoredTask[] }>({
  kind: "piko.work-items",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: [] }),
});
const LegacyReceipts = defineDocFamily<CommandReceipt, null>({
  kind: "piko.item-command",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  initial: () => ({ hash: "", id: "", executionId: null }),
});
const LegacyTaskContext = defineDoc<{ binding: LegacyTaskBinding | null }>({
  kind: "piko.item-context",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ binding: null }),
});
const TaskNamingMigration = defineDoc<{ version: number }>({
  kind: "piko.task-naming-migration",
  version: 1,
  scope: "session",
  initial: () => ({ version: 0 }),
});

const LEGACY_KINDS = [
  LegacyTaskDefinitions.definition.kind,
  LegacyReceipts.definition.kind,
  LegacyTaskContext.definition.kind,
] as const;
const TASK_ID_PATTERN = /^[a-zA-Z0-9-]{1,80}$/;
const PAGE_SIZE = 256;

type DirectoryPlan = {
  source: string;
  destination: string;
  entries: string[];
  destinationExists: boolean;
};
type LegacyTaskDocument =
  | { type: "definitions"; conversationId: ConversationId; tasks: StoredTask[] }
  | { type: "receipt"; conversationId: ConversationId; key: string; value: CommandReceipt }
  | { type: "context"; conversationId: ConversationId; binding: TaskBinding | null };

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function planTaskDirectoryMigration(workspace: string): Promise<DirectoryPlan | undefined> {
  const root = resolve(workspace);
  const workspaceInfo = await lstat(root);
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink() || (await realpath(root)) !== root)
    throw new Error("Task directory migration requires a regular workspace directory.");
  const source = join(root, "items");
  const destination = join(root, "tasks");
  const sourceInfo = await lstatOrUndefined(source);
  if (!sourceInfo) return undefined;
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink() || (await realpath(source)) !== source || !isWithin(root, source))
    throw new Error("Legacy items path is not a regular workspace directory; refusing to migrate it.");
  const destinationInfo = await lstatOrUndefined(destination);
  if (destinationInfo && (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink() || (await realpath(destination)) !== destination || !isWithin(root, destination)))
    throw new Error("Task path is not a regular workspace directory; refusing to migrate it.");
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !TASK_ID_PATTERN.test(entry.name))
      throw new Error(`Unexpected entry in legacy items directory: ${entry.name}`);
    const from = join(source, entry.name);
    if ((await realpath(from)) !== from || !isWithin(root, from))
      throw new Error(`Legacy task directory escapes the workspace: ${entry.name}`);
    if (destinationInfo && await lstatOrUndefined(join(destination, entry.name)))
      throw new Error(`Both items/${entry.name} and tasks/${entry.name} exist; refusing to merge or overwrite task data.`);
  }
  return { source, destination, entries: entries.map((entry) => entry.name), destinationExists: !!destinationInfo };
}

async function applyTaskDirectoryMigration(plan: DirectoryPlan | undefined) {
  if (!plan) return 0;
  if (plan.entries.length === 0) {
    await rmdir(plan.source);
    return 0;
  }
  if (!plan.destinationExists) {
    await rename(plan.source, plan.destination);
    return plan.entries.length;
  }
  for (const id of plan.entries) await rename(join(plan.source, id), join(plan.destination, id));
  await rmdir(plan.source);
  return plan.entries.length;
}

async function allConversationIds(storage: Storage): Promise<ConversationId[]> {
  const ids: ConversationId[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanConversations({}, PAGE_SIZE, cursor, ctx);
    ids.push(...page.items.map((conversation) => conversation.id));
    cursor = page.next;
  } while (cursor);
  return ids;
}

async function currentDocuments(
  storage: Storage,
  conversationId: ConversationId,
  kind: string,
): Promise<DocumentRecord[]> {
  const records: DocumentRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanDocuments(
      { scope: { kind: "conversation", conversationId }, at: "current", kind },
      PAGE_SIZE,
      cursor,
      ctx,
    );
    records.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return records;
}

function taskBinding(value: unknown): TaskBinding | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Legacy task context has an invalid binding.");
  const binding = value as Record<string, unknown>;
  if (typeof binding.itemId !== "string" || "taskId" in binding)
    throw new Error("Legacy task context cannot be migrated without ambiguity.");
  const { itemId, ...rest } = binding;
  return { ...rest, taskId: itemId } as TaskBinding;
}

async function collectLegacyTaskDocuments(storage: Storage): Promise<LegacyTaskDocument[]> {
  const result: LegacyTaskDocument[] = [];
  for (const conversationId of await allConversationIds(storage)) {
    for (const kind of LEGACY_KINDS) {
      for (const record of await currentDocuments(storage, conversationId, kind)) {
        if (record.scope.kind !== "conversation")
          throw new Error(`Legacy task document ${record.id} has an unexpected scope.`);
        const stored = await storage.document(record.id, "current", ctx);
        if (!stored) continue;
        const value = stored.value as Record<string, unknown>;
        if (kind === LegacyTaskDefinitions.definition.kind) {
          if (!Array.isArray(value.items) || "tasks" in value)
            throw new Error("Legacy task definitions cannot be migrated without ambiguity.");
          result.push({ type: "definitions", conversationId, tasks: value.items as StoredTask[] });
        } else if (kind === LegacyReceipts.definition.kind) {
          if (record.key === undefined || typeof value.hash !== "string" || typeof value.id !== "string" || !(value.executionId === null || typeof value.executionId === "string"))
            throw new Error("Legacy task receipt cannot be migrated without ambiguity.");
          result.push({
            type: "receipt",
            conversationId,
            key: record.key,
            value: { hash: value.hash, id: value.id, executionId: value.executionId },
          });
        } else {
          if (!("binding" in value)) throw new Error("Legacy task context is missing its binding.");
          result.push({ type: "context", conversationId, binding: taskBinding(value.binding) });
        }
      }
    }
  }
  return result;
}

async function checkNoTargetDocuments(storage: Storage, documents: readonly LegacyTaskDocument[]) {
  const seen = new Set<string>();
  for (const document of documents) {
    const kind = document.type === "definitions" ? TaskDefinitions.definition.kind
      : document.type === "receipt" ? Receipts.definition.kind
        : TaskContext.definition.kind;
    const scope = { kind: "conversation" as const, conversationId: document.conversationId };
    const key = document.type === "receipt" ? document.key : undefined;
    const identity = JSON.stringify([kind, scope, key ?? null]);
    if (seen.has(identity)) throw new Error("Duplicate legacy task document address; refusing migration.");
    seen.add(identity);
    const address = { kind, scope, ...(key === undefined ? {} : { key }) };
    if (await storage.findDocument(address, "current", ctx))
      throw new Error(`Both legacy and task-named Durable documents exist for ${kind}; refusing to overwrite task data.`);
  }
}

async function writeTaskDocuments(harness: Harness, documents: readonly LegacyTaskDocument[]) {
  if (!documents.length) return;
  await harness.commit(async (tx) => {
    for (const document of documents) {
      if (document.type === "definitions") {
        (await tx.doc(TaskDefinitions, document.conversationId)).tasks = document.tasks;
        await tx.retireDoc(LegacyTaskDefinitions, document.conversationId);
      } else if (document.type === "receipt") {
        const target = await tx.doc(Receipts, document.conversationId, document.key, null);
        target.hash = document.value.hash;
        target.id = document.value.id;
        target.executionId = document.value.executionId;
        await tx.retireDoc(LegacyReceipts, document.conversationId, document.key);
      } else {
        (await tx.doc(TaskContext, document.conversationId)).binding = document.binding;
        await tx.retireDoc(LegacyTaskContext, document.conversationId);
      }
    }
  }, ctx);
}

function remapExtensionSelection(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    const next = value.map((name) => name === "piko-work-items" ? "piko-tasks" : name);
    return { value: next, changed: next.some((name, index) => name !== value[index]) };
  }
  if (!value || typeof value !== "object") return { value, changed: false };
  const selection = value as Record<string, unknown>;
  let changed = false;
  const next = { ...selection };
  for (const key of ["add", "remove"]) {
    const names = selection[key];
    if (Array.isArray(names)) {
      next[key] = names.map((name) => {
        if (name !== "piko-work-items") return name;
        changed = true;
        return "piko-tasks";
      });
    }
  }
  return { value: next, changed };
}

async function migrateAgentExtensionNames(harness: Harness, storage: Storage, conversationIds: readonly ConversationId[]) {
  const changes: { conversationId: ConversationId; extensions: unknown }[] = [];
  for (const conversationId of conversationIds) {
    for (const record of await currentDocuments(storage, conversationId, AgentDoc.definition.kind)) {
      const stored = await storage.document(record.id, "current", ctx);
      if (!stored) continue;
      const state = stored.value as Record<string, unknown>;
      const mapped = remapExtensionSelection(state.extensions);
      if (mapped.changed) changes.push({ conversationId, extensions: mapped.value });
    }
  }
  if (!changes.length) return 0;
  await harness.commit(async (tx) => {
    for (const change of changes) {
      const agent = await tx.doc(AgentDoc, change.conversationId);
      agent.extensions = change.extensions as typeof agent.extensions;
    }
  }, ctx);
  return changes.length;
}

async function legacyDocumentCount(database: SqliteDatabase) {
  const row = await database.get<{ count: number }>(
    "SELECT count(*) AS count FROM documents WHERE kind IN (?, ?, ?) AND retired_at IS NULL",
    ...LEGACY_KINDS.map((kind) => JSON.stringify(kind)),
  );
  return row?.count ?? 0;
}

/** Idempotently migrate task-domain Durable documents and files before recovery or scheduling starts. */
export async function migrateTaskNaming(
  database: SqliteDatabase,
  storage: Storage,
  harness: Harness,
  workspace: string,
) {
  if ((await harness.snapshot(TaskNamingMigration, ctx))?.version === 1) return;
  const directoryPlan = await planTaskDirectoryMigration(workspace);
  const documents = await collectLegacyTaskDocuments(storage);
  await checkNoTargetDocuments(storage, documents);
  const conversationIds = await allConversationIds(storage);
  const extensionChanges = await migrateAgentExtensionNames(harness, storage, conversationIds);
  await writeTaskDocuments(harness, documents);
  const movedDirectories = await applyTaskDirectoryMigration(directoryPlan);
  await harness.commit(async (tx) => {
    (await tx.doc(TaskNamingMigration)).version = 1;
  }, ctx);
  if (documents.length || movedDirectories || extensionChanges)
    console.info("Piko task naming migration:", JSON.stringify({ documents: documents.length, directories: movedDirectories, agentExtensions: extensionChanges }));
}
