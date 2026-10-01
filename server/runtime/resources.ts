import { realpathSync } from "node:fs";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { isWithin, readGuidance, type WorkspacePaths } from "../domain/workspace";

/** Reuse Pi parsers, but never inherit the caller's CLI profile or ancestor resources. */
type ModelSelection = {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ReturnType<SettingsManager["getDefaultThinkingLevel"]>;
};

export function createWorkspaceResources(paths: WorkspacePaths, modelSelection: ModelSelection = {}) {
  const settingsManager = SettingsManager.inMemory({ ...modelSelection, compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } });
  const roots = [join(paths.workspace, ".agents/skills"), join(paths.resources, "skills")];
  const loader = new DefaultResourceLoader({
    cwd: paths.workspace,
    agentDir: join(paths.state, "pi"),
    settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalSkillPaths: roots,
    skillsOverride: (current) => ({
      skills: current.skills.filter((skill) => roots.some((root) => isWithin(realpathSync(root), realpathSync(skill.filePath)))),
      diagnostics: current.diagnostics,
    }),
    agentsFilesOverride: () => ({ agentsFiles: [
      { path: join(paths.workspace, "AGENTS.md"), content: readGuidance(paths.workspace, "AGENTS.md", 8000) },
    ] }),
    systemPromptOverride: () => [
      readGuidance(join(paths.resources, "prompts"), "core.md", 8000),
      ...(["SOUL.md", "USER.md", "MEMORY.md"] as const).map((name) =>
        `\n<workspace-note source="${name}">\n${readGuidance(paths.workspace, name, 4000)}\n</workspace-note>`),
    ].join("\n"),
    appendSystemPrompt: [],
  });
  return { loader, settingsManager };
}
