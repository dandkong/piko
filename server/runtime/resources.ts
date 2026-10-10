import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { isWithin, readGuidance, type WorkspacePaths } from "../domain/workspace";

export type WorkspaceSkill = { name: string; description: string; path: string; disableModelInvocation: boolean };
type GuidanceRole = "core" | "work_guidance" | "memory";
export type WorkspaceResources = { instructions: { role: GuidanceRole; path: string; content: string }[]; skills: WorkspaceSkill[];
  diagnostics: { path: string; message: string }[] };
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Explicit Piko roots, never ancestor instructions or personal Pi CLI resources. */
export async function loadWorkspaceResources(paths: WorkspacePaths, signal?: AbortSignal): Promise<WorkspaceResources> {
  const result: WorkspaceResources = { instructions: [], skills: [], diagnostics: [] };
  const warn = (path: string, message: string) => result.diagnostics.push({ path, message });
  for (const [root, name, limit, role] of [
    [join(paths.resources, "prompts"), "core.md", 8000, "core"],
    [paths.workspace, "AGENTS.md", 8000, "work_guidance"],
    [paths.workspace, "MEMORY.md", 4000, "memory"],
  ] as [string, string, number, GuidanceRole][]) {
    signal?.throwIfAborted();
    result.instructions.push({ role, path: join(root, name), content: readGuidance(root, name, limit) });
  }
  const byName = new Map<string, WorkspaceSkill>();
  let visited = 0;
  for (const root of [join(paths.resources, "skills"), join(paths.home, "skills"), join(paths.workspace, ".agents", "skills")]) {
    let canonical: string;
    try { canonical = await realpath(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn(root, "Cannot access skills directory"); continue; }
    const seen = new Set<string>();
    async function scan(directory: string, depth: number): Promise<void> {
      signal?.throwIfAborted();
      if (depth > 6 || visited >= 2000) { warn(directory, "Skill discovery limit reached"); return; }
      try {
        const real = await realpath(directory);
        if (!isWithin(canonical, real)) { warn(directory, "Skill directory escapes its declared root"); return; }
        if (seen.has(real)) return;
        seen.add(real); visited++;
        const entries = await readdir(directory, { withFileTypes: true });
        if (entries.some(entry => entry.name === "SKILL.md")) {
          const path = join(directory, "SKILL.md");
          if (!(await stat(path)).isFile() || !isWithin(canonical, await realpath(path))) { warn(path, "Invalid skill file"); return; }
          const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
          const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
          if (!match) { warn(path, "Skill requires YAML frontmatter"); return; }
          const metadata: unknown = Bun.YAML.parse(match[1]!);
          if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) { warn(path, "Invalid skill metadata"); return; }
          const value = metadata as Record<string, unknown>;
          if (typeof value.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.name)
            || typeof value.description !== "string" || !value.description.trim()) { warn(path, "Skill requires a name and description"); return; }
          if (value.name !== basename(directory)) warn(path, "Skill name differs from directory name");
          if (byName.has(value.name)) warn(path, `Overrides skill at ${byName.get(value.name)!.path}`);
          byName.set(value.name, { name: value.name, description: value.description, path,
            disableModelInvocation: value["disable-model-invocation"] === true });
          return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const child = join(directory, entry.name);
          if (entry.isDirectory() || (entry.isSymbolicLink() && (await stat(child)).isDirectory())) await scan(child, depth + 1);
          if (visited >= 2000) break;
        }
      } catch { signal?.throwIfAborted(); warn(directory, "Cannot parse or scan skill directory"); }
    }
    await scan(root, 0);
  }
  result.skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export function formatWorkspaceResources(resources: WorkspaceResources): string {
  const instructions = resources.instructions.map(file => `<instructions_file role="${file.role}" path="${escape(file.path)}">\n${file.content}\n</instructions_file>`);
  const skills = resources.skills.filter(skill => !skill.disableModelInvocation);
  if (skills.length) instructions.push(`<available_skills>\n${skills.map(skill => `<skill><name>${escape(skill.name)}</name><description>${escape(skill.description)}</description><location>${escape(skill.path)}</location></skill>`).join("\n")}\n</available_skills>`);
  return instructions.join("\n\n");
}

export function createWorkspaceResources(paths: WorkspacePaths) {
  const reported = new Set<string>();
  return defineExtension({ name: "piko-resources", sections: [
    section("cwd", () => paths.workspace),
    section("workspace_resources", async (_input, context) => {
      const resources = await loadWorkspaceResources(paths, context.abortSignal);
      for (const diagnostic of resources.diagnostics) {
        const key = `${diagnostic.path}:${diagnostic.message}`;
        if (!reported.has(key)) { reported.add(key); console.warn("Piko skill:", diagnostic.message, diagnostic.path); }
      }
      return formatWorkspaceResources(resources);
    }),
  ] });
}
