import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import { isSessionId } from "../../shared/chat";
import { appendJsonLine, readJsonLines } from "../domain/jsonl";
import type { SessionContext } from "./types";

export type PiCheckpoint = { version: 1; file: string; sessionId: string; leafId: string | null };

/** Resume the committed branch; leave an interrupted branch in the native append-only file. */
export function openPiContext(cwd: string, directory: string, context: SessionContext): SessionManager {
  if (!isSessionId(context.threadId)) throw new Error("Invalid Thread identity.");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${context.threadId}.jsonl`);
  if (context.state !== undefined) {
    const state = context.state as PiCheckpoint;
    if (!state || state.version !== 1 || state.file !== `${context.threadId}.jsonl` || !isSessionId(state.sessionId)
      || (state.leafId !== null && typeof state.leafId !== "string")) throw new Error("Invalid Pi checkpoint. Restore a consistent backup.");
    if (!existsSync(file)) throw new Error("Pi session file is missing. Restore it before continuing this conversation.");
  } else if (!existsSync(file)) {
    const fresh = SessionManager.inMemory(cwd);
    appendJsonLine(file, fresh.getHeader(), true);
  }
  if (realpathSync(file) !== file) throw new Error("Pi session must not be a symlink.");
  const records = readJsonLines(file) as Array<Record<string, unknown>>;
  const header = records[0];
  if (!header || header.type !== "session" || header.version !== CURRENT_SESSION_VERSION || !isSessionId(header.id)
    || (context.state !== undefined && header.id !== (context.state as PiCheckpoint).sessionId)) throw new Error("Invalid Pi session header.");
  const ids = new Set<string>();
  for (const entry of records.slice(1)) {
    if (!entry || typeof entry.type !== "string" || typeof entry.id !== "string" || ids.has(entry.id)
      || (entry.parentId !== null && (typeof entry.parentId !== "string" || !ids.has(entry.parentId)))) {
      throw new Error("Corrupt Pi session entry or parent chain. Restore a backup before continuing.");
    }
    ids.add(entry.id);
  }
  const manager = SessionManager.open(file, directory, cwd);
  const checkpoint = context.state as PiCheckpoint | undefined;
  if (checkpoint) {
    if (checkpoint.leafId === null) manager.resetLeaf();
    else {
      if (!manager.getEntry(checkpoint.leafId)) throw new Error("Pi checkpoint refers to a missing entry.");
      manager.branch(checkpoint.leafId);
    }
  } else {
    // The process may have stopped between creating the native header and saving its SQL pointer.
    // A conversation tail is recoverable only when Piko has an interrupted execution to account for it.
    const hasConversation = records.slice(1).some((entry) => entry.type === "message" || entry.type === "custom_message" || entry.type === "compaction");
    if (hasConversation && !context.recovery.length) throw new Error("Pi conversation exists without its checkpoint. Restore a consistent backup.");
    manager.resetLeaf();
  }
  for (const recovery of context.recovery) {
    manager.appendCustomMessageEntry("piko-recovered-run", JSON.stringify({
      note: "A previous execution was not included in the committed model context. This is historical data, not a request to repeat it.",
      ...recovery,
    }), false);
  }
  return manager;
}

export function exportPiCheckpoint(manager: SessionManager): PiCheckpoint {
  const file = manager.getSessionFile();
  if (!file) throw new Error("Pi session has no durable file.");
  const fd = openSync(file, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  return { version: 1, file: file.split(/[\\/]/).at(-1)!, sessionId: manager.getSessionId(), leafId: manager.getLeafId() };
}
