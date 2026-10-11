import { existsSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
export function sessionDirectory(directory: string): string {
  if (existsSync(directory) && (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory)) throw new Error("Durable storage must be a regular directory, not a symlink.");
  if (existsSync(directory) && !existsSync(join(directory, "main.jsonl")) && readdirSync(directory).some(name => /^doc-.*\.jsonl$/.test(name))) throw new Error("Durable main.jsonl is missing. Restore the complete native storage directory.");
  return directory;
}
export async function readPiContext(directory: string) {
  const path = sessionDirectory(directory);
  if (!existsSync(join(path, "main.jsonl"))) return undefined;
  const storage = await openNodeJsonlStorage(path, context, { fsync: true });
  const session = createSession(storage);
  try {
    if (!await session.commit(tx => tx.conversation(ROOT_CONVERSATION_ID), context)) throw new Error("Durable root conversation is missing.");
    return { session, storage };
  } catch (error) { await session.close(context); throw error; }
}
