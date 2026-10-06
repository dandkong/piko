import { closeSync, existsSync, fsyncSync, lstatSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, ROOT_CONVERSATION_ID, type Session, type Storage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { isSessionId } from "../../shared/chat";
import type { SessionContext } from "./types";

export type PiSessionReference = { version: 2; directory: string; conversationId: number };

export function sessionDirectory(directory: string, input: SessionContext): string {
  if (!isSessionId(input.threadId)) throw new Error("Invalid Thread identity.");
  const state = input.state as PiSessionReference | undefined;
  if (state !== undefined && (!state || state.version !== 2 || state.directory !== input.threadId
    || state.conversationId !== ROOT_CONVERSATION_ID)) {
    throw new Error("Invalid durable session reference. Old Pi sessions are not migrated; use a new PIKO_HOME or restore a consistent backup.");
  }
  const path = join(directory, input.threadId);
  if (existsSync(path) && (!lstatSync(path).isDirectory() || realpathSync(path) !== path)) {
    throw new Error("Durable session directory must be a regular directory, not a symlink.");
  }
  if (state && !existsSync(join(path, "main.jsonl"))) throw new Error("Durable session is missing. Restore a consistent backup.");
  return path;
}

export async function readPiContext(directory: string, input: SessionContext): Promise<{ session: Session; storage: Storage } | undefined> {
  const path = sessionDirectory(directory, input);
  if (!existsSync(join(path, "main.jsonl"))) return undefined;
  const storage = await openNodeJsonlStorage(path, context, { fsync: true });
  const session = createSession(storage);
  try {
    if (!await session.commit(tx => tx.conversation(ROOT_CONVERSATION_ID), context)) throw new Error("Durable root conversation is missing.");
    return { session, storage };
  } catch (error) { await session.close(context); throw error; }
}

/** Native sidecars are flushed by durable; flush the commit marker before saving SQL metadata. */
export function exportPiReference(directory: string, threadId: string): PiSessionReference {
  const fd = openSync(join(directory, threadId, "main.jsonl"), "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  return { version: 2, directory: threadId, conversationId: ROOT_CONVERSATION_ID };
}
