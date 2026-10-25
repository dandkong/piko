import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The SQLite recovery contract requires one writer for a Piko state directory. */
export function acquireBackendLock(stateDir: string): () => void {
  const path = join(stateDir, "backend.lock");
  const token = crypto.randomUUID();
  if (existsSync(path)) {
    let owner: { pid: number };
    try { owner = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new Error("Invalid Piko backend lock. Verify no backend is running before removing it."); }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error("Invalid Piko backend lock owner.");
    let alive = true;
    try { process.kill(owner.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
    if (alive) throw new Error(`Piko state is already owned by backend PID ${owner.pid}. Stop it before starting another backend.`);
    unlinkSync(path);
  }
  writeFileSync(path, JSON.stringify({ pid: process.pid, token }), { flag: "wx" });
  return () => {
    if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).token === token) unlinkSync(path);
  };
}
