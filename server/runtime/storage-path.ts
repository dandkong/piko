import { existsSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import { join } from "node:path";
export function sessionDirectory(directory: string): string {
  if (
    existsSync(directory) &&
    (!lstatSync(directory).isDirectory() ||
      realpathSync(directory) !== directory)
  )
    throw new Error(
      "Durable storage must be a regular directory, not a symlink.",
    );
  if (
    existsSync(directory) &&
    !existsSync(join(directory, "main.jsonl")) &&
    readdirSync(directory).some((name) => /^doc-.*\.jsonl$/.test(name))
  )
    throw new Error(
      "Durable main.jsonl is missing. Restore the complete native storage directory.",
    );
  return directory;
}
