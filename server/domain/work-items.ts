import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Cron } from "croner";
import type { ItemSchedule, WorkItemDraft } from "../../shared/work-items";
import { isWithin, readGuidance } from "./workspace";

export class WorkItemError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}
export function itemId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value)) throw new WorkItemError("Invalid item identity.");
  return value;
}
export function executionId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw new WorkItemError("Invalid execution identity.");
  return value;
}
/** once.at is an ISO 8601 instant with an explicit offset, normalized to UTC. */
function onceAt(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(text))
    throw new WorkItemError("Use an ISO 8601 time with an offset, such as 2026-10-22T09:00:00+08:00.");
  const at = Date.parse(text);
  if (!Number.isSafeInteger(at) || at <= 0 || at >= 8.64e15) throw new WorkItemError("Invalid time.");
  return new Date(at).toISOString();
}
export function itemDraft(value: unknown): WorkItemDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkItemError("An item is required.");
  const input = value as Record<string, unknown>;
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 160) throw new WorkItemError("Title must contain 1–160 characters.");
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 12000) throw new WorkItemError("Prompt must contain 1–12,000 characters.");
  let schedule: ItemSchedule = null;
  if (input.schedule !== null) {
    if (!input.schedule || typeof input.schedule !== "object" || Array.isArray(input.schedule)) throw new WorkItemError("Choose manual, once, or cron scheduling.");
    const rule = input.schedule as Record<string, unknown>;
    if (rule.type === "once") schedule = { type: "once", at: onceAt(rule.at) };
    else if (rule.type === "cron" && typeof rule.expression === "string" && typeof rule.timezone === "string") {
      const expression = rule.expression.trim().replace(/\s+/g, " ");
      if (expression.length > 120 || expression.split(" ").length !== 5 || rule.timezone.length > 100) throw new WorkItemError("Use a five-field cron expression and an IANA time zone.");
      try {
        new Intl.DateTimeFormat("en", { timeZone: rule.timezone });
        if (!new Cron(expression, { timezone: rule.timezone }).nextRun()) throw new Error("No future occurrence");
      }
      catch { throw new WorkItemError("Invalid cron expression or time zone."); }
      schedule = { type: "cron", expression, timezone: rule.timezone };
    } else throw new WorkItemError("Invalid schedule.");
  }
  const scheduleText = typeof input.scheduleText === "string" ? input.scheduleText.trim() : "";
  if (scheduleText.length > 120) throw new WorkItemError("Keep the schedule summary under 120 characters.");
  return { title: input.title.trim(), prompt: input.prompt.trim(), schedule, ...(scheduleText && { scheduleText }) };
}
/** Croner evaluates calendar/DST rules only; no library timer or second scheduler. */
export function nextDue(schedule: ItemSchedule, after: number): number | null {
  if (!schedule) return null;
  if (schedule.type === "once") return Date.parse(schedule.at);
  return new Cron(schedule.expression, { timezone: schedule.timezone }).nextRun(new Date(after))?.getTime() ?? null;
}
export function latestDue(schedule: Extract<ItemSchedule, { type: "cron" }>, now: number): number {
  return new Cron(schedule.expression, { timezone: schedule.timezone }).previousRuns(1, new Date(now + 1))[0]?.getTime() ?? now;
}

/** Explicit paths, no title-derived directory names, no symlink traversal in product file APIs. */
export class ItemFiles {
  constructor(private readonly workspace: string) {}
  directory(id: string) { return join(this.workspace, "items", itemId(id)); }
  private async checked(path: string, directory: boolean) {
    const base = await realpath(this.workspace);
    if (!isWithin(base, resolve(path))) throw new WorkItemError("Path escapes the workspace.");
    const relative = path.slice(this.workspace.length).split(/[\\/]/).filter(Boolean);
    let current = this.workspace;
    for (const part of relative) {
      current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new WorkItemError("Symbolic links are not supported in item paths.");
    }
    const info = await lstat(path);
    if (directory ? !info.isDirectory() : !info.isFile()) throw new WorkItemError("Invalid item file type.");
    if (!isWithin(base, await realpath(path)) || await realpath(path) !== resolve(path)) throw new WorkItemError("Path escapes its declared item location.");
    return info;
  }
  async prepare(id: string, execution?: string) {
    // Check each existing parent before mkdir; never follow a pre-existing directory link.
    const paths = [join(this.workspace, "items"), this.directory(id)];
    if (execution) paths.push(join(this.directory(id), "outputs"), join(this.directory(id), "outputs", executionId(execution)));
    for (const path of paths) {
      try { await mkdir(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      await this.checked(path, true);
    }
    const memory = join(this.directory(id), "MEMORY.md");
    try {
      const file = await open(memory, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await file.writeFile("# Item memory\n\nKeep only reusable findings and progress; refer to execution outputs for details.\n"); }
      finally { await file.close(); }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await this.checked(memory, false);
  }
  async memory(id: string) {
    const directory = this.directory(id);
    await this.checked(join(directory, "MEMORY.md"), false);
    return readGuidance(directory, "MEMORY.md", 4000);
  }
}
