import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { workspacePaths, type WorkspacePaths } from "./domain/workspace";
import { readConfigEnvironment, readJson, resolveConfigValue } from "./config/files";
import { defaultPikoFile } from "./config/defaults";

export type ServerConfig = {
  hostname: string;
  port: number;
  allowedOrigins: ReadonlySet<string>;
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
const fileSchema = object({
  http: Type.Optional(object({
    host: Type.Optional(text),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    corsOrigins: Type.Optional(Type.Array(text)),
  })),
  workspace: Type.Optional(object({ path: Type.Optional(text) })),
  // Optional channel errors are isolated so RN can still start.
  channels: Type.Optional(object({ telegram: Type.Optional(Type.Unknown()) })),
});
const telegramValidator = Compile(object({
  enabled: Type.Optional(Type.Boolean()),
  userId: Type.Optional(text),
  botToken: Type.Optional(text),
}));

/** Internal HTTP limits stay in code until they need a user-facing setting. */
export function defaultServerConfig(): ServerConfig {
  return {
    hostname: defaultPikoFile.http.host,
    port: defaultPikoFile.http.port,
    allowedOrigins: new Set(),
    idleSessionMs: 30 * 60 * 1000,
    maxSessions: 32,
    maxRequestBytes: 64_000,
  };
}

function invalid(field: string, expected: string): never {
  throw new Error(`Invalid Piko configuration at ${field}: expected ${expected}.`);
}

function port(value: string | number): number {
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) invalid("http.port / PIKO_PORT", "an integer from 1 to 65535");
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 65535) invalid("http.port / PIKO_PORT", "an integer from 1 to 65535");
  return result;
}

function enabled(value: string | boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value.trim().toLowerCase() === "true") return true;
  if (value.trim().toLowerCase() === "false") return false;
  return invalid("channels.telegram.enabled / PIKO_TELEGRAM_ENABLED", "true or false");
}

function origins(values: string[]): ReadonlySet<string> {
  return new Set(values.map(value => {
    try {
      const url = new URL(value.trim());
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
        || url.pathname !== "/" || url.search || url.hash) throw new Error();
      return url.origin;
    } catch { return invalid("http.corsOrigins / PIKO_CORS_ORIGINS", "HTTP(S) origins without paths or credentials"); }
  }));
}

function telegramConfig(
  value: unknown,
  env: Record<string, string | undefined>,
): PikoConfig["channels"]["telegram"] {
  // Explicitly disabling a channel must not require its credentials to resolve.
  if (env.PIKO_TELEGRAM_ENABLED !== undefined && !enabled(env.PIKO_TELEGRAM_ENABLED)) return { enabled: false };
  const candidate = value === undefined ? {} : value;
  if (!telegramValidator.Check(candidate)) {
    const error = [...telegramValidator.Errors(candidate)][0];
    return invalid(`channels.telegram${error?.instancePath ?? ""}`, "valid Telegram fields (enabled, userId, botToken)");
  }
  if (!enabled(env.PIKO_TELEGRAM_ENABLED ?? candidate.enabled ?? false)) return { enabled: false };
  const token = resolveConfigValue(env.PIKO_TELEGRAM_BOT_TOKEN ?? candidate.botToken ?? "", env, "channels.telegram.botToken").trim();
  if (!token) invalid("channels.telegram.botToken / PIKO_TELEGRAM_BOT_TOKEN", "a bot token when enabled");
  const userId = (env.PIKO_TELEGRAM_USER_ID ?? candidate.userId ?? "").trim();
  if (!/^[1-9]\d*$/.test(userId) || !Number.isSafeInteger(Number(userId))) {
    invalid("channels.telegram.userId / PIKO_TELEGRAM_USER_ID", "a positive numeric Telegram user ID");
  }
  return { enabled: true, token, userId };
}

/** Defaults < piko.json < config/.env < ambient env. Reads only; no global env mutation. */
export function loadPikoConfig(ambient: Record<string, string | undefined> = process.env): PikoConfig {
  // Home bootstraps discovery; the .env inside that home cannot relocate itself.
  const home = ambient.PIKO_HOME ?? join(homedir(), ".piko");
  if (!isAbsolute(home)) invalid("PIKO_HOME", "an absolute path");
  const root = resolve(home);
  const env = readConfigEnvironment(root, ambient);
  const file = readJson(join(root, "config", "piko.json"), fileSchema, {});
  const http = defaultServerConfig();
  const hostname = (env.PIKO_HOST ?? file.http?.host ?? http.hostname).trim();
  if (!hostname || /\s/.test(hostname)) invalid("http.host / PIKO_HOST", "a nonempty host without whitespace");
  const workspace = env.PIKO_WORKSPACE ?? file.workspace?.path ?? join(root, "workspace");
  if (!isAbsolute(workspace)) invalid("workspace.path / PIKO_WORKSPACE", "an absolute path");
  const warnings: string[] = [];
  let telegram: PikoConfig["channels"]["telegram"] = { enabled: false };
  try { telegram = telegramConfig(file.channels?.telegram, env); }
  catch (error) {
    warnings.push(`${(error as Error).message} Telegram is disabled; RN remains available.`);
  }
  return {
    paths: workspacePaths(root, workspace),
    http: {
      ...http,
      hostname,
      port: port(env.PIKO_PORT ?? file.http?.port ?? http.port),
      allowedOrigins: origins(env.PIKO_CORS_ORIGINS === undefined ? file.http?.corsOrigins ?? []
        : env.PIKO_CORS_ORIGINS.split(",").map(value => value.trim()).filter(Boolean)),
    },
    channels: { telegram },
    warnings,
  };
}
