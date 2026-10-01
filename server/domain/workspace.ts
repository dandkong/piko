import { mkdirSync, realpathSync, writeFileSync, lstatSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type WorkspacePaths = { workspace: string; state: string; database: string; resources: string };

export function resolveWorkspacePaths(env: Record<string, string | undefined> = process.env): WorkspacePaths {
  const home = env.PIKO_HOME ?? join(homedir(), ".piko");
  const workspace = env.PIKO_WORKSPACE ?? join(home, "workspace");
  if (!isAbsolute(home) || !isAbsolute(workspace)) throw new Error("PIKO_HOME and PIKO_WORKSPACE must be absolute paths.");
  return { workspace: resolve(workspace), state: resolve(home, "state"), database: resolve(home, "state/piko.sqlite"),
    resources: resolve(import.meta.dir, "../resources") };
}

export function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

/** No overwrite: repeated startup keeps user-authored files and rejects type conflicts. */
export function initializeWorkspace(paths: WorkspacePaths): WorkspacePaths {
  mkdirSync(paths.workspace, { recursive: true });
  mkdirSync(paths.state, { recursive: true });
  const workspace = realpathSync(paths.workspace);
  const state = realpathSync(paths.state);
  if (isWithin(workspace, state)) throw new Error("Piko state must be outside the assistant workspace.");
  for (const directory of [".agents", ".agents/skills", "memory", "projects", "artifacts"]) {
    const path = join(workspace, directory);
    mkdirSync(path, { recursive: true });
    if (!isWithin(workspace, realpathSync(path))) throw new Error(`Workspace directory escapes its root: ${directory}`);
  }
  for (const name of ["AGENTS.md", "SOUL.md", "USER.md", "MEMORY.md"]) {
    const path = join(workspace, name);
    const template = readGuidance(join(paths.resources, "templates"), name, 8000);
    try { writeFileSync(path, template, { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!lstatSync(path).isFile()) throw new Error(`Workspace guidance must be a regular file: ${name}`);
  }
  return { ...paths, workspace, state, database: join(state, "piko.sqlite") };
}

/** Bounded reads, including allocation; arbitrary files do not become prompt instructions. */
export function readGuidance(root: string, name: string, maxBytes: number): string {
  const path = join(root, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || !isWithin(realpathSync(root), realpathSync(path))) throw new Error(`Invalid guidance file: ${name}`);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, Math.min(size, maxBytes)).toString("utf8")
      + (size > maxBytes ? "\n[Guidance truncated; only the bounded prefix was loaded.]" : "");
  } finally { closeSync(fd); }
}
