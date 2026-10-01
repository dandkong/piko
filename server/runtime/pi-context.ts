import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import { isSessionId } from "../../shared/chat";
import { appendJsonLine, readJsonLines } from "../domain/jsonl";
import type { SessionContext } from "./types";

export type PiSessionReference = { version: 1; file: string; sessionId: string };

/** Validate native storage without rolling back its canonical conversation to a SQL leaf. */
export function readPiContext(cwd: string, directory: string, context: SessionContext): SessionManager | undefined {
  if (!isSessionId(context.threadId)) throw new Error("Invalid Thread identity.");
  const file = join(directory, context.threadId + ".jsonl");
  const state = context.state as PiSessionReference | undefined;
  if (state !== undefined && (!state || state.version !== 1 || state.file !== context.threadId + ".jsonl" || !isSessionId(state.sessionId))) {
    throw new Error("Invalid Pi session reference. Restore a consistent backup.");
  }
  if (!existsSync(file)) {
    if (state) throw new Error("Pi session file is missing. Restore it before continuing this conversation.");
    return undefined;
  }
  if (realpathSync(file) !== file) throw new Error("Pi session must not be a symlink.");
  const records = readJsonLines(file) as Array<Record<string, unknown>>;
  const header = records[0];
  if (!header || header.type !== "session" || header.version !== CURRENT_SESSION_VERSION || !isSessionId(header.id)
    || (state && header.id !== state.sessionId)) throw new Error("Invalid Pi session header.");
  const ids = new Set<string>();
  for (const entry of records.slice(1)) {
    if (!entry || typeof entry.type !== "string" || typeof entry.id !== "string" || ids.has(entry.id)
      || (entry.parentId !== null && (typeof entry.parentId !== "string" || !ids.has(entry.parentId)))) {
      throw new Error("Corrupt Pi session entry or parent chain. Restore a backup before continuing.");
    }
    ids.add(entry.id);
  }
  return SessionManager.open(file, directory, cwd);
}

/** Resume native history as saved, including completed messages from an interrupted execution. */
export function openPiContext(cwd: string, directory: string, context: SessionContext): SessionManager {
  mkdirSync(directory, { recursive: true });
  let manager = readPiContext(cwd, directory, context);
  if (!manager) {
    appendJsonLine(join(directory, context.threadId + ".jsonl"), SessionManager.inMemory(cwd).getHeader(), true);
    manager = readPiContext(cwd, directory, context)!;
  }
  const interrupted = new Set(manager.getBranch().flatMap((entry) =>
    entry.type === "custom_message" && entry.customType === "piko-interrupted-run"
      && typeof (entry.details as { runId?: unknown } | undefined)?.runId === "string"
      ? [(entry.details as { runId: string }).runId] : []));
  for (const runId of context.interruptedRunIds) {
    if (interrupted.has(runId)) continue;
    manager.appendCustomMessageEntry("piko-interrupted-run",
      "Execution " + runId + " was interrupted by a server restart. Any messages already saved are historical context. "
      + "Do not resume or repeat that execution or its tools automatically; respond only to the next user request.",
      false, { runId });
  }
  return manager;
}

export function exportPiReference(manager: SessionManager): PiSessionReference {
  const file = manager.getSessionFile();
  if (!file) throw new Error("Pi session has no durable file.");
  const fd = openSync(file, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  return { version: 1, file: file.split(/[\\/]/).at(-1)!, sessionId: manager.getSessionId() };
}
