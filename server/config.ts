import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { workspacePaths, type WorkspacePaths } from "./domain/workspace";
import { readConfigEnvironment, readJsonValue, resolveConfigValue } from "./config/files";
import { defaultPikoFile } from "./config/defaults";

export type ServerConfig = {
  hostname: string;
  port: number;
  idleSessionMs: number;
  maxSessions: number;
  maxRequestBytes: number;
};
export type TelegramConfig = { token: string; userId: string };
export type PikoConfig = {
  paths: WorkspacePaths;
  http: ServerConfig;
  channels: { telegram: { enabled: false } | ({ enabled: true } & TelegramConfig) };
  warnings: readonly string[];
};

const object = <T extends Record<string, import("typebox").TSchema>>(fields: T) =>
  Type.Object(fields, { additionalProperties: false });
const text = Type.String({ minLength: 1 });
const configValidator = Compile(object({
  http: object({
    host: text,
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
  }),
  workspace: object({ path: text }),
  // Optional channel errors are isolated so RN can still start.
  channels: object({ telegram: Type.Unknown() }),
}));
const telegramValidator = Compile(object({
  enabled: Type.Boolean(),
  userId: Type.Optional(text),
  botToken: Type.Optional(text),
}));

/** Internal HTTP limits stay in code until they need a user-facing setting. */
export function defaultServerConfig(): ServerConfig {
  return {
    hostname: defaultPikoFile.http.host,
    port: defaultPikoFile.http.port,
    idleSessionMs: 30 * 60 * 1000,
    maxSessions: 32,
    maxRequestBytes: 64_000,
  };
}

function invalid(field: string, expected: string): never {
  throw new Error(`Invalid Piko configuration at ${field}: expected ${expected}.`);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Object fields merge; arrays/scalars replace. Preserve unknown fields for validation. */
function merge(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (!record(override)) return override;
  if (!record(base)) return override;
  return { ...base, ...Object.fromEntries(Object.entries(override).map(([key, value]) => [key, merge(base[key], value)])) };
}

function defined(fields: Record<string, unknown>): Record<string, unknown> | undefined {
  const result = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  return Object.keys(result).length ? result : undefined;
}

/** Convert syntax only; invalid values reach the same validator as JSON values. */
function numberFromEnv(value: string | undefined): unknown {
  return value !== undefined && /^\d+$/.test(value.trim()) ? Number(value) : value;
}

function booleanFromEnv(value: string | undefined): unknown {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" ? true : normalized === "false" ? false : value;
}

function environmentOverrides(env: Record<string, string | undefined>) {
  const telegram = defined({
    enabled: booleanFromEnv(env.PIKO_TELEGRAM_ENABLED),
    userId: env.PIKO_TELEGRAM_USER_ID,
    botToken: env.PIKO_TELEGRAM_BOT_TOKEN,
  });
  return defined({
    http: defined({
      host: env.PIKO_HOST,
      port: numberFromEnv(env.PIKO_PORT),
    }),
    workspace: defined({ path: env.PIKO_WORKSPACE }),
    channels: telegram ? { telegram } : undefined,
  });
}

function telegramConfig(
  value: unknown,
  env: Record<string, string | undefined>,
): PikoConfig["channels"]["telegram"] {
  const candidate = value;
  if (!telegramValidator.Check(candidate)) {
    const error = [...telegramValidator.Errors(candidate)][0];
    return invalid(`channels.telegram${error?.instancePath?.replaceAll("/", ".") ?? ""}`, "valid Telegram fields (enabled, userId, botToken)");
  }
  if (!candidate.enabled) return { enabled: false };
  const token = resolveConfigValue(candidate.botToken ?? "", env, "channels.telegram.botToken").trim();
  if (!token) invalid("channels.telegram.botToken", "a bot token when enabled");
  const userId = (candidate.userId ?? "").trim();
  if (!/^[1-9]\d*$/.test(userId) || !Number.isSafeInteger(Number(userId))) {
    invalid("channels.telegram.userId", "a positive numeric Telegram user ID");
  }
  return { enabled: true, token, userId };
}

/** One validation path for the final values, independent of their source. */
function validateConfig(candidate: unknown, root: string, env: Record<string, string | undefined>): PikoConfig {
  if (!configValidator.Check(candidate)) {
    const error = [...configValidator.Errors(candidate)][0];
    const field = error?.instancePath?.slice(1).replaceAll("/", ".") || "configuration";
    // Report a field, never the invalid value (which may contain a credential).
    throw new Error(`Invalid configuration at ${field}: ${error?.message ?? "invalid value"}`);
  }
  const hostname = candidate.http.host.trim();
  if (!hostname || /\s/.test(hostname)) invalid("http.host", "a nonempty host without whitespace");
  const workspace = candidate.workspace.path;
  if (!isAbsolute(workspace)) invalid("workspace.path", "an absolute path");
  const warnings: string[] = [];
  let telegram: PikoConfig["channels"]["telegram"] = { enabled: false };
  try { telegram = telegramConfig(candidate.channels.telegram, env); }
  catch (error) {
    warnings.push(`${(error as Error).message} Telegram is disabled; RN remains available.`);
  }
  return {
    paths: workspacePaths(root, workspace),
    http: { ...defaultServerConfig(), hostname, port: candidate.http.port },
    channels: { telegram },
    warnings,
  };
}

/** Defaults < piko.json < config/.env < ambient env. Reads only; no global env mutation. */
export function loadPikoConfig(ambient: Record<string, string | undefined> = process.env): PikoConfig {
  // Home bootstraps discovery; the .env inside that home cannot relocate itself.
  const home = ambient.PIKO_HOME ?? join(homedir(), ".piko");
  if (!isAbsolute(home)) invalid("PIKO_HOME", "an absolute path");
  const root = resolve(home);
  const env = readConfigEnvironment(root, ambient);
  const file = readJsonValue(join(root, "config", "piko.json"), {});
  if (!record(file)) invalid("configuration", "a JSON object");
  const defaults = { ...defaultPikoFile, workspace: { path: join(root, "workspace") } };
  const candidate = merge(merge(defaults, file), environmentOverrides(env));
  return validateConfig(candidate, root, env);
}
