import { mkdir, mkdtemp } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
  err,
  FileError,
  ok,
  type Result,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { readConfigEnvironment } from "../config/files";

const SKILL_ENVIRONMENT_KEYS = [
  "NOTION_API_KEY",
  "PORTAINER_API_KEY",
  "PORTAINER_URL",
  "PORTAINER_VERIFY_TLS",
  "KARAKEEP_API_KEY",
  "KARAKEEP_API_TOKEN",
  "KARAKEEP_SERVER_ADDR",
  "MEMOS_API_TOKEN",
  "MEMOS_SERVER_ADDR",
  "MEMOS_USE_PROXY",
  "MOVIEPILOT_API_TOKEN",
  "MOVIEPILOT_SERVER_ADDR",
  "PROWLARR_API_KEY",
  "QB_USERNAME",
  "QB_PASSWORD",
  "NAVIDROME_USERNAME",
  "NAVIDROME_PASSWORD",
  "NAVIDROME_URL",
  "NAVIDROME_CLIENT_NAME",
  "NAVIDROME_API_VERSION",
  "NAVIDROME_TIMEOUT_SECONDS",
  "TG_API_ID",
  "TG_API_HASH",
  "TG_SESSION",
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
] as const;

/** Only explicitly supported user-skill settings and credentials pass from config/.env to shell tools. */
export function readSkillEnvironment(
  home: string,
  ambient: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const configured = readConfigEnvironment(home, ambient);
  const result: Record<string, string> = {};
  for (const name of SKILL_ENVIRONMENT_KEYS) {
    const value = configured[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

/** Keep spill files and child-process temporary files in Piko's state/tmp directory. */
export class WorkspaceExecutionEnv extends NodeExecutionEnv {
  constructor(
    cwd: string,
    private readonly temporaryDirectory: string,
    home: string,
  ) {
    super({
      cwd,
      shellEnv: {
        ...process.env,
        ...readSkillEnvironment(home),
        TMPDIR: temporaryDirectory,
        TMP: temporaryDirectory,
        TEMP: temporaryDirectory,
      },
    });
    mkdirSync(temporaryDirectory, { recursive: true });
  }
  override async createTempDir(
    prefix: string | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    if (context.abortSignal?.aborted)
      return err(new FileError("aborted", "aborted"));
    const name = prefix ?? "tmp-";
    if (!name || name === "." || name === ".." || /[\\/]/.test(name))
      return err(
        new FileError("invalid", "Invalid temporary directory prefix"),
      );
    try {
      await mkdir(this.temporaryDirectory, { recursive: true });
      return ok(await mkdtemp(join(this.temporaryDirectory, name)));
    } catch (error) {
      return err(
        new FileError(
          "unknown",
          error instanceof Error
            ? error.message
            : "Cannot create workspace temporary directory",
        ),
      );
    }
  }
}
