import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, truncateSync, writeFileSync } from "node:fs";

/** Durable creation of a native session header; normal messages are written by Pi. */
export function appendJsonLine(path: string, value: unknown, create = false): void {
  const fd = openSync(path, create ? "wx" : "a");
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
}

/** Fail on interior corruption; archive a torn final append before repairing it. */
export function readJsonLines(path: string): unknown[] {
  const raw = readFileSync(path);
  const entries: unknown[] = [];
  let start = 0;
  for (let end = 0; end <= raw.length; end++) {
    if (end !== raw.length && raw[end] !== 10) continue;
    const line = raw.subarray(start, end).toString("utf8");
    if (line.trim()) {
      try { entries.push(JSON.parse(line)); }
      catch {
        if (end !== raw.length) throw new Error(`Corrupt JSONL record in ${path} at byte ${start}. Restore a backup before continuing.`);
        const backup = `${path}.torn-${Date.now()}`;
        writeFileSync(backup, raw.subarray(start), { flag: "wx" });
        truncateSync(path, start);
        console.warn(`Archived incomplete final JSONL record to ${backup}`);
      }
    }
    start = end + 1;
  }
  if (raw.length && raw.at(-1) !== 10 && existsSync(path) && readFileSync(path).length === raw.length) appendFileSync(path, "\n");
  return entries;
}
