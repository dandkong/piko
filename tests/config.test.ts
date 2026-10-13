import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { loadPikoConfig, readApplicationSettings } from "../server/config";
import { readConfigEnvironment } from "../server/config/files";
import { initializeWorkspace } from "../server/domain/workspace";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected test directory");
  rmSync(root, { recursive: true, force: true });
} });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "piko-config-test-")); roots.push(home);
  const config = join(home, "config");
  const file = (value: unknown) => { mkdirSync(config, { recursive: true }); writeFileSync(join(config, "piko.json"), JSON.stringify(value)); };
  const dotenv = (value: string) => { mkdirSync(config, { recursive: true }); writeFileSync(join(config, ".env"), value); };
  const load = (env: Record<string, string | undefined> = {}) => loadPikoConfig({ ...env, PIKO_HOME: home });
  return { home, config, file, dotenv, load };
}

test("defaults have no read side effects and initialization writes only behavior JSON, never deployment or credentials", () => {
  const f = fixture(); const initial = f.load();
  expect(initial.http).toMatchObject({ hostname: "127.0.0.1", port: 8787 });
  expect(initial.channels.telegram).toEqual({ enabled: false });
  expect(initial.paths.workspace).toBe(join(f.home, "workspace"));
  expect(initial.tools).toEqual({ web_search: { enabled: true }, web_extract: { enabled: true } });
  expect(existsSync(f.config)).toBe(false);
  initializeWorkspace(f.load({ PIKO_PORT: "9191", PIKO_TELEGRAM_BOT_TOKEN: "must-not-persist" }).paths);
  const saved = readFileSync(join(f.config, "piko.json"), "utf8");
  expect(JSON.parse(saved)).toEqual({ version: 1, agent: { profiles: {} }, channels: { telegram: { enabled: false } }, tools: initial.tools });
  expect(existsSync(join(f.config, "settings.json"))).toBe(false);
  expect(saved).not.toContain('"retry"'); expect(saved).not.toContain('"compaction"');
  expect(saved).not.toContain("must-not-persist"); expect(saved).not.toContain("9191");
  expect(existsSync(join(f.config, "auth.json"))).toBe(false);
  f.file({ tools: { web_search: { enabled: false } } }); f.dotenv("PIKO_PORT=9393\n");
  const authored = readFileSync(join(f.config, "piko.json"), "utf8");
  initializeWorkspace(f.load().paths);
  expect(readFileSync(join(f.config, "piko.json"), "utf8")).toBe(authored);
  expect(readFileSync(join(f.config, ".env"), "utf8")).toBe("PIKO_PORT=9393\n");
});

test("JSON behavior and env deployment/credentials have disjoint ownership, with ambient precedence only inside env", () => {
  const f = fixture(); const workspace = join(f.home, "custom-workspace");
  f.file({ channels: { telegram: { enabled: true, userId: "42" } }, tools: { web_extract: { enabled: false } } });
  f.dotenv(`PIKO_HOST=0.0.0.0\nPIKO_PORT=9002\nPIKO_WORKSPACE=${workspace}\nPIKO_TELEGRAM_BOT_TOKEN=local-secret\n`);
  const local = f.load();
  expect(local.http).toMatchObject({ hostname: "0.0.0.0", port: 9002 }); expect(local.paths.workspace).toBe(workspace);
  expect(local.channels.telegram).toEqual({ enabled: true, userId: "42", token: "local-secret" });
  expect(local.tools.web_extract.enabled).toBe(false);
  const ambientWorkspace = join(f.home, "ambient-workspace");
  const ambient = f.load({ PIKO_HOST: "127.0.0.1", PIKO_PORT: "9003", PIKO_WORKSPACE: ambientWorkspace, PIKO_TELEGRAM_BOT_TOKEN: "ambient-secret" });
  expect(ambient.http).toMatchObject({ hostname: "127.0.0.1", port: 9003 }); expect(ambient.paths.workspace).toBe(ambientWorkspace);
  expect(ambient.channels.telegram).toEqual({ enabled: true, userId: "42", token: "ambient-secret" });
  expect(ambient.tools).toEqual(local.tools); expect(ambient.warnings).toEqual([]);
  f.dotenv(""); expect(f.load().http.port).toBe(8787);
});

test("deployment parameters and credentials in JSON are rejected even with valid environment values", () => {
  const f = fixture();
  for (const value of [
    { http: { host: "private-host", port: 9191 } }, { workspace: { path: f.home } }, { PIKO_HOME: f.home },
    { channels: { telegram: { enabled: false, botToken: "private-token" } } },
    { channels: { telegram: { enabled: true, botToken: "env:PIKO_TELEGRAM_BOT_TOKEN" } } },
    { tools: { web_search: { apiKey: "private-key" } } }, { tools: { web_search: { apiKey: "env:BRAVE_SEARCH_API_KEY" } } },
  ]) {
    f.file(value);
    const run = () => f.load({ PIKO_HOST: "127.0.0.1", PIKO_PORT: "8787", PIKO_WORKSPACE: join(f.home, "workspace"), PIKO_TELEGRAM_BOT_TOKEN: "valid-token" });
    expect(run).toThrow("JSON accepts only application behavior"); expect(run).not.toThrow("private-token"); expect(run).not.toThrow("private-key");
  }
});

test("behavior variables are rejected in both dotenv and process env, not treated as overrides or silently ignored", () => {
  const f = fixture(); f.file({ channels: { telegram: { enabled: false } } });
  for (const name of ["PIKO_TELEGRAM_ENABLED", "PIKO_TELEGRAM_USER_ID", "PIKO_WEB_SEARCH_ENABLED", "PIKO_WEB_EXTRACT_ENABLED"]) {
    expect(() => f.load({ [name]: "private-value" })).toThrow("only in config/piko.json");
    expect(() => f.load({ [name]: "private-value" })).not.toThrow("private-value");
    f.dotenv(`${name}=false\n`); expect(() => f.load()).toThrow(name); f.dotenv("");
  }
});

test("home is process bootstrap and deployment paths require absolute values", () => {
  const f = fixture(); f.dotenv(`PIKO_HOME=${join(f.home, "ignored")}\n`);
  expect(f.load().paths.home).toBe(f.home);
  expect(() => loadPikoConfig({ PIKO_HOME: "relative" })).toThrow("PIKO_HOME");
  expect(() => f.load({ PIKO_WORKSPACE: "relative" })).toThrow("PIKO_WORKSPACE");
  expect(() => initializeWorkspace(f.load({ PIKO_WORKSPACE: f.home }).paths)).toThrow("outside");
});

test("environment HTTP parsing rejects invalid ports and hosts without exposing values", () => {
  const f = fixture();
  for (const value of ["", "NaN", "0", "65536", "12.5", "1e3", "0x123", "private-port-value"])
    expect(() => f.load({ PIKO_PORT: value })).toThrow("PIKO_PORT");
  expect(() => f.load({ PIKO_PORT: "private-port-value" })).not.toThrow("private-port-value");
  for (const host of ["", " \t", "localhost private-value"]) expect(() => f.load({ PIKO_HOST: host })).toThrow("PIKO_HOST");
});

test("invalid JSON and behavior schemas are rejected before runtime without exposing supplied values", () => {
  const f = fixture();
  for (const value of [{ unknown: "private-value" }, { channels: "private-value" }, { channels: null },
    { channels: { telegram: { enabled: "private-value" } } }, { tools: { web_search: { enabled: "private-value" } } },
    { tools: { web_extract: { secret: "private-value" } } }, { tools: [] }]) {
    f.file(value); expect(() => f.load()).toThrow("Invalid configuration"); expect(() => f.load()).not.toThrow("private-value");
  }
  writeFileSync(join(f.config, "piko.json"), '{"secret":"private-json-value"');
  expect(() => f.load()).toThrow("Invalid JSON"); expect(() => f.load()).not.toThrow("private-json-value");
  for (const value of [null, [], "private-value"]) { f.file(value); expect(() => f.load()).toThrow("JSON object"); }
});

test("JSON partial settings inherit behavior defaults but environment cannot repair invalid JSON", () => {
  const f = fixture(); f.file({ tools: { web_search: { enabled: false } } });
  expect(readApplicationSettings(f.home).tools).toEqual({ web_search: { enabled: false }, web_extract: { enabled: true } });
  f.file({ tools: { web_search: { enabled: "invalid" } } });
  expect(() => f.load({ PIKO_PORT: "9191" })).toThrow("tools.web_search.enabled");
  f.file({ http: { port: "invalid" } }); expect(() => f.load({ PIKO_PORT: "9191" })).toThrow("http");
});

test("Telegram enablement and authorized user are JSON-only and disabling skips credential validation", () => {
  const f = fixture();
  expect(f.load({ PIKO_TELEGRAM_BOT_TOKEN: "token" }).channels.telegram).toEqual({ enabled: false });
  f.file({ channels: { telegram: { enabled: false, userId: "invalid-user" } } });
  expect(f.load().warnings).toEqual([]);
  f.file({ channels: { telegram: { enabled: true, userId: "42" } } });
  expect(f.load({ PIKO_TELEGRAM_BOT_TOKEN: "token" }).channels.telegram).toEqual({ enabled: true, userId: "42", token: "token" });
});

test("missing token and invalid authorized user disable only Telegram and redact private input", () => {
  const f = fixture();
  for (const userId of [undefined, "@private-user", "9007199254740992"]) {
    f.file({ channels: { telegram: { enabled: true, ...(userId && { userId }) } } });
    const result = f.load({ PIKO_TELEGRAM_BOT_TOKEN: "private-token-value" });
    expect(result.http.port).toBe(8787); expect(result.channels.telegram).toEqual({ enabled: false });
    expect(result.warnings).toHaveLength(1); expect(result.warnings[0]).toContain("RN remains available");
    expect(result.warnings[0]).not.toContain("private-token-value"); expect(result.warnings[0]).not.toContain("@private-user");
  }
  f.file({ channels: { telegram: { enabled: true, userId: "42" } } });
  expect(f.load().warnings[0]).toContain("PIKO_TELEGRAM_BOT_TOKEN");
  f.dotenv("PIKO_TELEGRAM_BOT_TOKEN=local-secret\n");
  expect(f.load({ PIKO_TELEGRAM_BOT_TOKEN: "" }).channels.telegram).toEqual({ enabled: false });
});

test("piko.json owns versioned Agent profiles and rejects removed retry/compaction settings", () => {
  const f = fixture();
  f.file({ version: 1, agent: { defaultProfile: "quick", profiles: {
    quick: { provider: "deepseek", model: "deepseek-flash", thinking: "off" },
  } } });
  expect(readApplicationSettings(f.home).agent).toEqual({ defaultProfile: "quick", profiles: {
    quick: { provider: "deepseek", model: "deepseek-flash", thinking: "off" },
  } });
  f.file({ agent: { defaultProfile: "private-invalid-profile" } });
  expect(() => f.load()).toThrow("agent.defaultProfile");
  expect(() => f.load()).not.toThrow("private-invalid-profile");
  for (const value of [
    { version: 2 }, { defaultProfile: "quick" }, { profiles: {} },
    { retry: { enabled: true } }, { compaction: { enabled: true } },
    { agent: { retry: { enabled: true } } }, { agent: { compaction: { enabled: true } } },
    { agent: { profiles: { quick: { provider: "deepseek", model: "deepseek-flash", thinking: "invalid" } } } },
  ]) { f.file(value); expect(() => f.load()).toThrow("Invalid configuration"); }
});

test("settings.json is not generated, parsed, merged or used as a second profile source", () => {
  const f = fixture(); f.file({ agent: { profiles: {} } });
  writeFileSync(join(f.config, "settings.json"), '{"secret":"private-legacy-value"');
  expect(() => f.load()).toThrow("settings.json is no longer supported");
  expect(() => f.load()).not.toThrow("private-legacy-value");
});

test("shared dotenv supports quotes and escapes and does not mutate ambient or global environments", () => {
  const f = fixture(); f.dotenv('# comment\nexport PIKO_PORT=\'9000\'\nPIKO_CONFIG_TEST_SECRET="local value" # comment\nOTHER=value # comment\n');
  const ambient = { PIKO_CONFIG_TEST_SECRET: "ambient value", OTHER: undefined }; const before = process.env.PIKO_CONFIG_TEST_SECRET;
  expect(readConfigEnvironment(f.home, ambient)).toMatchObject({ PIKO_PORT: "9000", PIKO_CONFIG_TEST_SECRET: "ambient value", OTHER: "value" });
  f.load(); expect(process.env.PIKO_CONFIG_TEST_SECRET).toBe(before); expect(ambient).toEqual({ PIKO_CONFIG_TEST_SECRET: "ambient value", OTHER: undefined });
  const literal = 'quoted " slash \\ literal \\n newline\n';
  f.dotenv(`ESCAPED=${JSON.stringify(literal)}\n`); expect(readConfigEnvironment(f.home, {}).ESCAPED).toBe(literal);
  f.dotenv("INVALID LINE containing private-value\n"); expect(() => f.load()).toThrow("line 1"); expect(() => f.load()).not.toThrow("private-value");
});
