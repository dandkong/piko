import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { loadPikoConfig } from "../server/config";
import { readConfigEnvironment } from "../server/config/files";
import { initializeWorkspace } from "../server/domain/workspace";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "piko-config-test-"));
  roots.push(home);
  const config = join(home, "config");
  const file = (value: unknown) => {
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "piko.json"), JSON.stringify(value));
  };
  const dotenv = (value: string) => {
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, ".env"), value);
  };
  const load = (env: Record<string, string | undefined> = {}) => loadPikoConfig({ ...env, PIKO_HOME: home });
  return { home, config, file, dotenv, load };
}

test("loading defaults has no filesystem side effects and initialization never persists environment overrides", () => {
  const f = fixture();
  expect(f.load().http).toMatchObject({ hostname: "127.0.0.1", port: 8787 });
  expect(f.load().channels.telegram).toEqual({ enabled: false });
  expect(f.load().paths.workspace).toBe(join(f.home, "workspace"));
  expect(existsSync(f.config)).toBe(false);
  initializeWorkspace(f.load({ PIKO_PORT: "9191", PIKO_TELEGRAM_BOT_TOKEN: "must-not-persist" }).paths);
  const saved = readFileSync(join(f.config, "piko.json"), "utf8");
  expect(JSON.parse(saved)).toMatchObject({ http: { port: 8787 }, channels: { telegram: { enabled: false } } });
  expect(saved).not.toContain("must-not-persist");
  expect(saved).not.toContain("9191");
  f.file({ http: { port: 9292 }, channels: { telegram: { enabled: false } } });
  f.dotenv("PIKO_PORT=9393\n");
  const authored = readFileSync(join(f.config, "piko.json"), "utf8");
  initializeWorkspace(f.load().paths);
  expect(readFileSync(join(f.config, "piko.json"), "utf8")).toBe(authored);
  expect(readFileSync(join(f.config, ".env"), "utf8")).toBe("PIKO_PORT=9393\n");
});

test("file, local environment and ambient overrides use one precedence for HTTP, workspace and Telegram", () => {
  const f = fixture();
  const workspace = join(f.home, "custom-workspace");
  f.file({ http: { host: "0.0.0.0", port: 9001, corsOrigins: ["https://file.example"] },
    workspace: { path: workspace }, channels: { telegram: { enabled: true, userId: "42", botToken: "env:TEST_BOT_TOKEN" } } });
  f.dotenv("PIKO_PORT=9002\nPIKO_CORS_ORIGINS=https://local.example\nTEST_BOT_TOKEN=local-secret\n");
  const local = f.load();
  expect(local.http).toMatchObject({ hostname: "0.0.0.0", port: 9002 });
  expect([...local.http.allowedOrigins]).toEqual(["https://local.example"]);
  expect(local.paths.workspace).toBe(workspace);
  expect(local.channels.telegram).toEqual({ enabled: true, userId: "42", token: "local-secret" });
  const ambientWorkspace = join(f.home, "ambient-workspace");
  const ambient = f.load({ PIKO_HOST: "127.0.0.1", PIKO_PORT: "9003", PIKO_CORS_ORIGINS: "https://ambient.example,https://ambient.example",
    PIKO_WORKSPACE: ambientWorkspace, PIKO_TELEGRAM_USER_ID: "43", PIKO_TELEGRAM_BOT_TOKEN: "ambient-secret" });
  expect(ambient.http).toMatchObject({ hostname: "127.0.0.1", port: 9003 });
  expect([...ambient.http.allowedOrigins]).toEqual(["https://ambient.example"]);
  expect(ambient.paths.workspace).toBe(ambientWorkspace);
  expect(ambient.channels.telegram).toEqual({ enabled: true, userId: "43", token: "ambient-secret" });
  expect(ambient.warnings).toEqual([]);
  expect([...f.load({ PIKO_CORS_ORIGINS: "" }).http.allowedOrigins]).toEqual([]);
  f.dotenv("");
  expect(f.load().http.port).toBe(9001);
  expect([...f.load().http.allowedOrigins]).toEqual(["https://file.example"]);
});

test("home is a bootstrap parameter and both home and workspace require absolute paths", () => {
  const f = fixture();
  f.dotenv(`PIKO_HOME=${join(f.home, "ignored")}\n`);
  expect(f.load().paths.home).toBe(f.home);
  expect(() => loadPikoConfig({ PIKO_HOME: "relative" })).toThrow("PIKO_HOME");
  f.file({ workspace: { path: "relative" } });
  expect(() => f.load()).toThrow("workspace.path");
  f.file({});
  expect(() => f.load({ PIKO_WORKSPACE: "relative" })).toThrow("PIKO_WORKSPACE");
  expect(() => initializeWorkspace(f.load({ PIKO_WORKSPACE: f.home }).paths)).toThrow("outside");
});

test("HTTP parsing rejects invalid ports, hosts and CORS origins with safe field errors", () => {
  const f = fixture();
  for (const value of ["", "NaN", "0", "65536", "12.5", "1e3", "0x123", "private-port-value"]) {
    expect(() => f.load({ PIKO_PORT: value })).toThrow("http.port");
  }
  expect(() => f.load({ PIKO_PORT: "private-port-value" })).not.toThrow("private-port-value");
  for (const host of ["", " \t", "localhost private-value"]) expect(() => f.load({ PIKO_HOST: host })).toThrow("http.host");
  for (const origin of ["null", "*", "ftp://localhost", "https://user:private-value@example.com", "https://example.com/path", "https://example.com?token=private-value"]) {
    expect(() => f.load({ PIKO_CORS_ORIGINS: origin })).toThrow("corsOrigins");
  }
  expect([...f.load({ PIKO_CORS_ORIGINS: "https://EXAMPLE.com/" }).http.allowedOrigins]).toEqual(["https://example.com"]);
});

test("malformed JSON, unknown core fields and invalid field types are rejected without exposing values", () => {
  const f = fixture();
  for (const value of [{ http: { port: "private-value" } }, { workspace: { path: 1 } }, { http: { post: 8787 } }, { unknown: "private-value" }]) {
    f.file(value);
    expect(() => f.load()).toThrow("Invalid configuration");
    expect(() => f.load()).not.toThrow("private-value");
  }
  writeFileSync(join(f.config, "piko.json"), '{"secret":"private-json-value"');
  expect(() => f.load()).toThrow("Invalid JSON");
  expect(() => f.load()).not.toThrow("private-json-value");
});

test("Telegram requires explicit enablement and disabling skips credential resolution", () => {
  const f = fixture();
  expect(f.load({ PIKO_TELEGRAM_BOT_TOKEN: "token", PIKO_TELEGRAM_USER_ID: "42" }).channels.telegram).toEqual({ enabled: false });
  f.file({ channels: { telegram: { enabled: false, botToken: "env:MISSING_TEST_BOT_TOKEN" } } });
  expect(f.load().warnings).toEqual([]);
  f.file({ channels: { telegram: { enabled: true, botToken: "env:MISSING_TEST_BOT_TOKEN" } } });
  expect(f.load({ PIKO_TELEGRAM_ENABLED: "false" }).warnings).toEqual([]);
  expect(f.load({ PIKO_TELEGRAM_ENABLED: "false" }).channels.telegram).toEqual({ enabled: false });
  expect(f.load({ PIKO_TELEGRAM_ENABLED: "TRUE", PIKO_TELEGRAM_USER_ID: "42", PIKO_TELEGRAM_BOT_TOKEN: "token" }).channels.telegram)
    .toEqual({ enabled: true, token: "token", userId: "42" });
});

test("invalid enabled Telegram settings disable only that channel and redact credential values", () => {
  const f = fixture();
  for (const env of [
    { PIKO_TELEGRAM_ENABLED: "yes" },
    { PIKO_TELEGRAM_ENABLED: "true" },
    { PIKO_TELEGRAM_ENABLED: "true", PIKO_TELEGRAM_BOT_TOKEN: "private-token-value", PIKO_TELEGRAM_USER_ID: "@private-user" },
    { PIKO_TELEGRAM_ENABLED: "true", PIKO_TELEGRAM_BOT_TOKEN: "private-token-value", PIKO_TELEGRAM_USER_ID: "9007199254740992" },
  ]) {
    const result = f.load(env);
    expect(result.http.port).toBe(8787);
    expect(result.channels.telegram).toEqual({ enabled: false });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("RN remains available");
    expect(result.warnings[0]).not.toContain("private-token-value");
    expect(result.warnings[0]).not.toContain("@private-user");
  }
  f.file({ channels: { telegram: { enabled: true, userId: "42", botToken: 123 } } });
  expect(f.load().warnings[0]).toContain("botToken");
  f.file({ channels: { telegram: { enabled: true, userId: "42", botToken: "env:MISSING_TEST_BOT_TOKEN" } } });
  expect(f.load().warnings[0]).toContain("Missing environment variable MISSING_TEST_BOT_TOKEN");
  f.file({ channels: { telegram: { enabled: true, userId: "42", botToken: "token", typo: "private-value" } } });
  expect(f.load().warnings).toHaveLength(1);
  expect(f.load().warnings[0]).not.toContain("private-value");
});

test("shared dotenv parsing supports quoted values and ambient precedence without global mutation", () => {
  const f = fixture();
  f.dotenv("# comment\nexport PIKO_PORT='9000'\nPIKO_CONFIG_TEST_SECRET=\"local value\" # comment\nOTHER=value # comment\n");
  const ambient = { PIKO_CONFIG_TEST_SECRET: "ambient value", OTHER: undefined };
  const before = process.env.PIKO_CONFIG_TEST_SECRET;
  expect(readConfigEnvironment(f.home, ambient)).toMatchObject({ PIKO_PORT: "9000", PIKO_CONFIG_TEST_SECRET: "ambient value", OTHER: "value" });
  f.load();
  expect(process.env.PIKO_CONFIG_TEST_SECRET).toBe(before);
  expect(ambient).toEqual({ PIKO_CONFIG_TEST_SECRET: "ambient value", OTHER: undefined });
  f.dotenv("INVALID LINE containing private-value\n");
  expect(() => f.load()).toThrow("line 1");
  expect(() => f.load()).not.toThrow("private-value");
});
