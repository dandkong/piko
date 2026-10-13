import { expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, type OAuthCredential } from "@earendil-works/pi-ai";
import { EnvironmentCredentialStore } from "../server/runtime/credentials";
import { readConfigEnvironment } from "../server/config/files";
import { loadWorkspaceModels } from "../server/runtime/model-config";
import { fixture, cleanup } from "./fixtures/durable";

const credential = (access = "0"): OAuthCredential => ({ type: "oauth", access, refresh: 'refresh " \\ literal \\n', expires: 9999999999999, accountId: "test-account" });
const assignment = (value: OAuthCredential) => `PIKO_OAUTH_TEST=${JSON.stringify(JSON.stringify(value))}\n`;

test("OAuth refresh writes only private dotenv, serializes updates and publishes to active readers without JSON secrets", async () => {
  const f = await fixture(); const path = join(f.paths.home, "config/.env");
  await writeFile(path, '# keep comment\nDEEPSEEK_API_KEY="private-key"\nPIKO_PORT=9191\n' + assignment(credential()), { mode: 0o644 });
  const store = new EnvironmentCredentialStore(f.paths.home, readConfigEnvironment(f.paths.home, {}));
  const peer = new EnvironmentCredentialStore(f.paths.home, readConfigEnvironment(f.paths.home, {}));
  await Promise.all(Array.from({ length: 10 }, () => store.modify("test", async current => {
    await Bun.sleep(1); return { ...current as OAuthCredential, access: String(Number((current as OAuthCredential).access) + 1) };
  })));
  expect(await store.read("test")).toEqual(credential("10")); expect(await peer.read("test")).toEqual(credential("10"));
  const env = readConfigEnvironment(f.paths.home, {});
  expect(JSON.parse(env.PIKO_OAUTH_TEST!)).toEqual(credential("10")); expect(env.DEEPSEEK_API_KEY).toBe("private-key");
  expect(env.PIKO_PORT).toBe("9191"); expect(await readFile(path, "utf8")).toContain("# keep comment");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const restarted = new EnvironmentCredentialStore(f.paths.home, env);
  expect(await restarted.read("test")).toEqual(credential("10"));
  expect(await restarted.list()).toEqual([{ providerId: "test", type: "oauth" }]);
  for (const name of ["piko.json", "models.json"])
    expect(await readFile(join(f.paths.home, "config", name), "utf8")).not.toContain("private-key");
  await store.delete("test"); expect(await peer.read("test")).toBeUndefined();
  expect(readConfigEnvironment(f.paths.home, {}).PIKO_OAUTH_TEST).toBeUndefined();
  expect(readConfigEnvironment(f.paths.home, {}).DEEPSEEK_API_KEY).toBe("private-key");
});

test("pi-ai actually refreshes OAuth once under concurrent requests and reopens its dotenv result after restart", async () => {
  const f = await fixture(); const path = join(f.paths.home, "config/.env");
  await writeFile(path, assignment({ ...credential(), expires: 0 }));
  let refreshes = 0;
  const provider = { ...f.faux.provider, id: "test", auth: { oauth: {
    name: "Test OAuth", login: async () => credential(),
    refresh: async () => { refreshes++; await Bun.sleep(5); return credential("refreshed-token"); },
    toAuth: async (value: OAuthCredential) => ({ apiKey: value.access }),
  } } };
  const models = createModels({ credentials: new EnvironmentCredentialStore(f.paths.home, readConfigEnvironment(f.paths.home, {})),
    authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(provider);
  const results = await Promise.all(Array.from({ length: 8 }, () => models.getAuth("test")));
  expect(refreshes).toBe(1); expect(results.every(result => result?.auth.apiKey === "refreshed-token")).toBe(true);
  const reopened = createModels({ credentials: new EnvironmentCredentialStore(f.paths.home, readConfigEnvironment(f.paths.home, {})) });
  reopened.setProvider(provider);
  expect((await reopened.getAuth("test"))?.auth.apiKey).toBe("refreshed-token"); expect(refreshes).toBe(1);
});

test("manual credential edits take effect only in a new store and malformed values never replace an active snapshot", async () => {
  const f = await fixture(); const path = join(f.paths.home, "config/.env"); await writeFile(path, assignment(credential()));
  const store = new EnvironmentCredentialStore(f.paths.home, readConfigEnvironment(f.paths.home, {}));
  await writeFile(path, assignment(credential("edited")));
  expect((await store.read("test"))?.access).toBe("0");
  expect((await new EnvironmentCredentialStore(f.paths.home, readConfigEnvironment(f.paths.home, {})).read("test"))?.access).toBe("edited");
  await writeFile(path, 'PIKO_OAUTH_TEST="invalid-private-token"\n');
  expect(() => new EnvironmentCredentialStore(f.paths.home, readConfigEnvironment(f.paths.home, {}))).toThrow("Invalid OAuth environment credential");
  expect(() => new EnvironmentCredentialStore(f.paths.home, readConfigEnvironment(f.paths.home, {}))).not.toThrow("invalid-private-token");
  expect((await store.read("test"))?.access).toBe("0");
});

test("API keys cannot be written through CredentialStore and cancelled mutations do not write secrets", async () => {
  const f = await fixture(); const store = new EnvironmentCredentialStore(f.paths.home, {});
  await expect(store.modify("test", async () => ({ type: "api_key", key: "private-key" }))).rejects.toThrow("API keys belong in backend environment variables");
  const controller = new AbortController(); controller.abort(); let called = false;
  await expect(store.modify("test", async () => { called = true; return credential(); }, { signal: controller.signal })).rejects.toThrow();
  expect(called).toBe(false); expect(await store.read("test")).toBeUndefined();
});

test("mutable OAuth tokens cannot come from a stale process environment override", async () => {
  const f = await fixture(); const value = JSON.stringify(credential()); const previous = process.env.PIKO_OAUTH_TEST;
  process.env.PIKO_OAUTH_TEST = value;
  cleanup(() => { if (previous === undefined) delete process.env.PIKO_OAUTH_TEST; else process.env.PIKO_OAUTH_TEST = previous; });
  expect(() => new EnvironmentCredentialStore(f.paths.home, { PIKO_OAUTH_TEST: value })).toThrow("only in config/.env");
});

test("model JSON rejects literal and legacy credential/header values but accepts only environment-name bindings", async () => {
  const f = await fixture(); const path = join(f.paths.home, "config/models.json");
  for (const fields of [{ apiKey: "private-key" }, { apiKey: "env:CUSTOM_API_KEY" }, { headers: { Authorization: "private-token" } },
    { headersEnv: { Authorization: "env:CUSTOM_AUTH" } }, { headersEnv: { Authorization: "private-token" } }]) {
    await writeFile(path, JSON.stringify({ providers: { custom: fields } }));
    await expect(loadWorkspaceModels(f.paths.home)).rejects.toThrow("Invalid configuration");
    await expect(loadWorkspaceModels(f.paths.home)).rejects.not.toThrow("private-token");
  }
});
