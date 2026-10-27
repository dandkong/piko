import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Compile } from "typebox/compile";
import type { ModelSelection } from "../../shared/runtime";
import type {
  SaveSettingsConfiguration, SettingsBackgroundModel, SettingsConfigurationSnapshot,
  SettingsCredentialOperation,
} from "../../shared/settings";
import { SETTINGS_CREDENTIAL_PROVIDERS } from "../../shared/settings";
import { readJsonValue } from "../config/files";
import { validateApplicationSettings, readApplicationSettings } from "../config";
import { modelsSchema } from "../config/model-schema";
import { parseStoredCredentials, storedCredentialsSchema, type StoredCredentials } from "../runtime/credentials";

const modelsValidator = Compile(modelsSchema);
const credentialsValidator = Compile(storedCredentialsSchema);
const allowedFiles = new Set(["piko.json", "models.json", "auth.json"]);
const temporaryPrefix = ".piko-settings-txn-";
const maxModelDirectoryBytes = 1_000_000;

export class SettingsRevisionConflictError extends Error {
  readonly status = 409;
  constructor() { super("配置已被其他操作修改，请重新读取后再保存。"); }
}
export class SettingsValidationError extends Error {
  readonly status = 400;
}

export type SettingsCandidate = {
  mainModel: ModelSelection | null;
  backgroundModel: SettingsBackgroundModel;
  modelDirectory: { providers: Record<string, { keyless?: boolean; models?: { id: string }[]; modelOverrides?: Record<string, unknown> }> };
  credentials: SettingsConfigurationSnapshot["credentials"];
  credentialChanges: { providerId: string; action: "set" | "delete" }[];
};
type ModelDirectory = { providers: Record<string, Record<string, unknown>> };
type JournalEntry = { name: string; existed: boolean; backupName: string; stagedName: string };
type Journal = { version: 1; id: string; files: JournalEntry[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safeJson(value: unknown, name: string): unknown {
  try { return JSON.parse(String(value ?? "")); }
  catch { throw new SettingsValidationError(`${name} 不是有效 JSON。`); }
}
function assertRegularOrMissing(path: string) {
  try {
    if (!lstatSync(path).isFile()) throw new SettingsValidationError(`配置文件不是普通文件：${path.split("/").at(-1)}。`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
function assertDirectory(path: string) {
  try {
    if (!lstatSync(path).isDirectory()) throw new SettingsValidationError("配置事务目录无效。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (!lstatSync(path).isDirectory()) throw new SettingsValidationError("配置事务目录无效。");
  }
}
function writePrivate(path: string, data: string | Uint8Array) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, Buffer.from(data));
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
function syncDirectory(path: string) {
  let fd: number | undefined;
  try { fd = openSync(path, "r"); fsyncSync(fd); }
  catch { /* directory sync is not supported on every filesystem */ }
  finally { if (fd !== undefined) closeSync(fd); }
}
function normalized(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(normalized).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${normalized(value[key])}`).join(",")}}`;
}
function assertNoInlineCredentials(value: ModelDirectory) {
  for (const [providerId, provider] of Object.entries(value.providers)) {
    if (Object.hasOwn(provider, "apiKey"))
      throw new SettingsValidationError(`模型目录中的 ${providerId}.apiKey 不可直接编辑，请使用凭据输入框。`);
    const baseUrl = provider.baseUrl;
    if (typeof baseUrl === "string") {
      try {
        const url = new URL(baseUrl);
        if (url.username || url.password || url.search || url.hash)
          throw new SettingsValidationError(`供应商 ${providerId} 的 baseUrl 不能包含凭据、查询参数或片段。`);
      } catch (error) {
        if (error instanceof SettingsValidationError) throw error;
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl))
          throw new SettingsValidationError(`供应商 ${providerId} 的 baseUrl 必须是绝对 URL。`);
        throw new SettingsValidationError(`供应商 ${providerId} 的 baseUrl 无效。`);
      }
    }
  }
}
function profile(value: ModelSelection | null): { provider: string; model: string; thinking: NonNullable<ModelSelection["thinking"]> } | undefined {
  if (!value) return undefined;
  return { provider: value.provider, model: value.model, thinking: value.thinking ?? "off" };
}
function selection(value: { provider: string; model: string; thinking?: string } | undefined): ModelSelection | null {
  return value ? { provider: value.provider, model: value.model, thinking: (value.thinking ?? "off") as ModelSelection["thinking"] } : null;
}
function sanitizeDirectory(value: ModelDirectory): ModelDirectory {
  const providers: ModelDirectory["providers"] = {};
  for (const [id, config] of Object.entries(value.providers).sort(([a], [b]) => a.localeCompare(b))) {
    const safe = structuredClone(config);
    delete safe.apiKey;
    providers[id] = safe;
  }
  return { providers };
}
function readCredentialFile(path: string): StoredCredentials {
  if (!existsSync(path)) return {};
  const value = readJsonValue(path, {});
  if (!credentialsValidator.Check(value)) throw new SettingsValidationError("auth.json 凭据结构无效，未执行保存。");
  return parseStoredCredentials(value);
}
function credentialStates(models: ModelDirectory, credentials: StoredCredentials) {
  const editableProviderIds = new Set<string>(SETTINGS_CREDENTIAL_PROVIDERS.map(provider => provider.id));
  const ids = new Set([...Object.keys(models.providers), ...Object.keys(credentials)]);
  return [...ids].sort().map(providerId => {
    const auth = credentials[providerId];
    const inline = typeof models.providers[providerId]?.apiKey === "string" && String(models.providers[providerId]?.apiKey).length > 0;
    const apiKey = !editableProviderIds.has(providerId) ? undefined : auth?.type === "api_key" ? auth.key
      : auth?.type === "oauth" ? undefined
        : typeof models.providers[providerId]?.apiKey === "string" ? models.providers[providerId].apiKey
          : undefined;
    const sources: SettingsConfigurationSnapshot["credentials"][number]["sources"] = [];
    if (auth) sources.push("auth.json");
    if (inline) sources.push("models.json");
    return {
      providerId,
      configured: !!auth || inline,
      type: auth?.type ?? (inline ? "api_key" as const : null),
      sources,
      ...(apiKey ? { apiKey } : {}),
    };
  });
}

/** Small synchronous file transaction for the three private configuration files. */
export function recoverSettingsTransactions(home: string) {
  const root = resolve(home);
  const configDir = join(root, "config");
  const transactions = join(root, "state", "config-transactions");
  if (!existsSync(transactions)) return;
  assertDirectory(transactions);
  for (const entry of readdirSync(transactions, { withFileTypes: true })) {
    const dir = join(transactions, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Invalid settings transaction entry.");
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) { rmSync(dir, { recursive: true, force: true }); continue; }
    if (existsSync(join(dir, "COMMITTED"))) { rmSync(dir, { recursive: true, force: true }); continue; }
    let journal: Journal;
    try { journal = JSON.parse(readFileSync(manifestPath, "utf8")) as Journal; }
    catch { throw new Error("Unfinished settings transaction cannot be recovered."); }
    if (journal.version !== 1 || !/^[a-f0-9]{32}$/.test(journal.id) || !Array.isArray(journal.files) || !journal.files.length)
      throw new Error("Unfinished settings transaction is invalid.");
    for (const file of journal.files) {
      if (!allowedFiles.has(file.name) || file.backupName !== `backup-${file.name}` || file.stagedName !== `${temporaryPrefix}${journal.id}-${file.name}.tmp`)
        throw new Error("Unfinished settings transaction contains an invalid path.");
      const target = join(configDir, file.name);
      assertRegularOrMissing(target);
      if (file.existed) {
        const backup = join(dir, file.backupName);
        if (!existsSync(backup)) throw new Error("Settings transaction backup is missing.");
        const restore = join(configDir, `${temporaryPrefix}${journal.id}-restore-${file.name}`);
        writePrivate(restore, readFileSync(backup));
        renameSync(restore, target);
      } else rmSync(target, { force: true });
    }
    syncDirectory(configDir);
    rmSync(dir, { recursive: true, force: true });
  }
  for (const name of readdirSync(configDir))
    if (name.startsWith(temporaryPrefix) && name.endsWith(".tmp")) rmSync(join(configDir, name), { force: true });
}

function transactionWrite(home: string, updates: Map<string, string>) {
  const configDir = join(resolve(home), "config");
  assertDirectory(configDir);
  for (const name of updates.keys()) {
    if (!allowedFiles.has(name)) throw new Error("Unsupported configuration file.");
    assertRegularOrMissing(join(configDir, name));
  }
  const id = randomUUID().replaceAll("-", "");
  const transactionRoot = join(resolve(home), "state", "config-transactions");
  assertDirectory(transactionRoot);
  const dir = join(transactionRoot, id);
  mkdirSync(dir, { mode: 0o700 });
  const files: JournalEntry[] = [];
  try {
    for (const [name, content] of updates) {
      const target = join(configDir, name);
      const existed = existsSync(target);
      const backupName = `backup-${name}`;
      const stagedName = `${temporaryPrefix}${id}-${name}.tmp`;
      if (existed) writePrivate(join(dir, backupName), readFileSync(target));
      writePrivate(join(configDir, stagedName), content);
      files.push({ name, existed, backupName, stagedName });
    }
    writePrivate(join(dir, "manifest.json"), JSON.stringify({ version: 1, id, files } satisfies Journal));
    syncDirectory(dir);
    for (const file of files) renameSync(join(configDir, file.stagedName), join(configDir, file.name));
    syncDirectory(configDir);
    writePrivate(join(dir, "COMMITTED"), "ok\n");
    syncDirectory(dir);
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    try { recoverSettingsTransactions(home); } catch { throw new Error("配置写入失败，且自动恢复未完成；请保留数据目录并检查配置事务。"); }
    throw error;
  }
}

export class SettingsConfigurationStore {
  private readonly revisionSecret = randomBytes(32);
  private queue: Promise<unknown> = Promise.resolve();
  private readonly home: string;
  constructor(home: string) { this.home = resolve(home); }

  private paths() {
    const config = join(this.home, "config");
    return { piko: join(config, "piko.json"), models: join(config, "models.json"), auth: join(config, "auth.json") };
  }
  private revision() {
    const hmac = createHmac("sha256", this.revisionSecret);
    for (const [name, path] of Object.entries(this.paths())) {
      assertRegularOrMissing(path);
      hmac.update(name).update("\0");
      try { hmac.update(readFileSync(path)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        hmac.update("<missing>");
      }
      hmac.update("\0");
    }
    return hmac.digest("hex");
  }
  private readRaw() {
    const paths = this.paths();
    const application = readApplicationSettings(this.home);
    const modelRaw = readJsonValue(paths.models, { providers: {} });
    if (!modelsValidator.Check(modelRaw)) throw new SettingsValidationError("models.json 结构无效。");
    const models = modelRaw as ModelDirectory;
    const credentials = readCredentialFile(paths.auth);
    return { application, models, credentials };
  }
  async snapshot(): Promise<SettingsConfigurationSnapshot> {
    const revision = this.revision();
    const { application, models, credentials } = this.readRaw();
    if (revision !== this.revision()) throw new SettingsRevisionConflictError();
    const safe = sanitizeDirectory(models);
    return {
      revision,
      mainModel: selection(application.agent.profiles.main),
      backgroundModel: selection(application.agent.profiles.background ?? application.agent.profiles.main),
      modelDirectory: JSON.stringify(safe, null, 2),
      credentials: credentialStates(models, credentials),
    };
  }

  save(draft: SaveSettingsConfiguration, validate?: (candidate: SettingsCandidate) => Promise<void> | void): Promise<{ snapshot: SettingsConfigurationSnapshot; restartRequired: boolean }> {
    const task = this.queue.catch(() => {}).then(() => this.saveLocked(draft, validate));
    this.queue = task;
    return task;
  }

  private async saveLocked(draft: SaveSettingsConfiguration, validate?: (candidate: SettingsCandidate) => Promise<void> | void) {
    const currentRevision = this.revision();
    const expected = Buffer.from(draft.baseRevision);
    const actual = Buffer.from(currentRevision);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new SettingsRevisionConflictError();

    const raw = this.readRaw();
    if (Buffer.byteLength(draft.modelDirectory) > maxModelDirectoryBytes)
      throw new SettingsValidationError("模型目录 JSON 超过 1 MB。");
    const candidateUnknown = safeJson(draft.modelDirectory, "模型目录");
    if (!modelsValidator.Check(candidateUnknown)) throw new SettingsValidationError("模型目录字段或结构无效。");
    const candidateModels = candidateUnknown as ModelDirectory;
    assertNoInlineCredentials(candidateModels);
    if (!Array.isArray(draft.credentialOperations) || draft.credentialOperations.length > 64)
      throw new SettingsValidationError("凭据操作数量无效。");
    const providerIds = new Set<string>();
    for (const operation of draft.credentialOperations) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(operation.providerId) || providerIds.has(operation.providerId))
        throw new SettingsValidationError("供应商 ID 无效或凭据操作重复。");
      providerIds.add(operation.providerId);
      if (operation.action === "set" && (!operation.key.trim() || operation.key.length > 8192))
        throw new SettingsValidationError(`供应商 ${operation.providerId} 的 API Key 为空或过长。`);
      if (operation.action !== "set" && operation.action !== "delete")
        throw new SettingsValidationError("凭据操作无效。");
    }

    const application = structuredClone(raw.application);
    const main = profile(draft.mainModel);
    // An omitted background selection is initialized from the main profile when saved.
    const background = profile(draft.backgroundModel ?? draft.mainModel);
    application.agent.profiles.main = main;
    application.agent.profiles.background = background;
    validateApplicationSettings(application);

    const nextModels = structuredClone(candidateModels);
    const operationsByProvider = new Map(draft.credentialOperations.map(operation => [operation.providerId, operation]));
    for (const [providerId, current] of Object.entries(raw.models.providers)) {
      const key = current.apiKey;
      if (typeof key === "string" && key.length && nextModels.providers[providerId] && !operationsByProvider.has(providerId))
        nextModels.providers[providerId]!.apiKey = key;
    }
    const auth = structuredClone(raw.credentials);
    for (const operation of draft.credentialOperations) {
      const stored = auth[operation.providerId];
      const inlineKey = raw.models.providers[operation.providerId]?.apiKey;
      if (operation.action === "delete" && stored?.type !== "api_key" && !(typeof inlineKey === "string" && inlineKey.length))
        throw new SettingsValidationError(`供应商 ${operation.providerId} 没有可删除的 API Key。`);
      if (stored?.type === "oauth")
        throw new SettingsValidationError(`供应商 ${operation.providerId} 使用 OAuth；API Key 表单不会替换或删除 OAuth。`);
      if (operation.action === "set") {
        auth[operation.providerId] = { ...(stored ?? {}), type: "api_key", key: operation.key.trim() } as StoredCredentials[string];
      } else delete auth[operation.providerId];
      const provider = nextModels.providers[operation.providerId];
      if (provider) delete provider.apiKey;
    }
    if (!credentialsValidator.Check(auth)) throw new SettingsValidationError("凭据变更无效。");
    const sanitizedCandidate = sanitizeDirectory(nextModels);
    const candidateBackground: SettingsBackgroundModel = draft.backgroundModel ?? draft.mainModel;
    await validate?.({
      mainModel: draft.mainModel,
      backgroundModel: candidateBackground,
      modelDirectory: sanitizedCandidate as SettingsCandidate["modelDirectory"],
      credentials: credentialStates(nextModels, auth),
      credentialChanges: draft.credentialOperations.map(({ providerId, action }) => ({ providerId, action })),
    });

    const modelChanged = normalized(sanitizeDirectory(raw.models)) !== normalized(sanitizeDirectory(nextModels));
    const credentialsChanged = draft.credentialOperations.length > 0;
    const pikoChanged = normalized({
      main: selection(raw.application.agent.profiles.main),
      background: selection(raw.application.agent.profiles.background ?? raw.application.agent.profiles.main),
    }) !== normalized({ main: selection(main), background: selection(background) });
    if (currentRevision !== this.revision()) throw new SettingsRevisionConflictError();
    const updates = new Map<string, string>();
    if (pikoChanged) updates.set("piko.json", `${JSON.stringify(application, null, 2)}\n`);
    if (modelChanged || credentialsChanged) updates.set("models.json", `${JSON.stringify(nextModels, null, 2)}\n`);
    if (credentialsChanged) updates.set("auth.json", `${JSON.stringify(auth, null, 2)}\n`);
    if (updates.size) transactionWrite(this.home, updates);
    return {
      snapshot: await this.snapshot(),
      restartRequired: modelChanged || credentialsChanged,
    };
  }
}

export function assertCredentialOperations(value: unknown): asserts value is SettingsCredentialOperation[] {
  if (!Array.isArray(value) || value.some(item => !isRecord(item) || typeof item.providerId !== "string" ||
    (item.action !== "set" && item.action !== "delete") || (item.action === "set" && typeof item.key !== "string")))
    throw new SettingsValidationError("凭据操作格式无效。");
}
