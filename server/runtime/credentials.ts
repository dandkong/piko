import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { AuthOperationOptions, Credential, CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import { optionalText } from "../config/files";

const prefix = "PIKO_OAUTH_";
const validator = Compile(Type.Object({ type: Type.Literal("oauth"), refresh: Type.String(), access: Type.String(), expires: Type.Number({ minimum: 0 }) }));
const writers = new Map<string, Promise<unknown>>();
const readers = new Map<string, Set<WeakRef<EnvironmentCredentialStore>>>();
const nameFor = (provider: string) => prefix + provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");

/** API keys are resolved by provider env auth. Only mutable OAuth state needs a CredentialStore. */
export class EnvironmentCredentialStore implements CredentialStore {
  readonly path: string;
  private values: Record<string, OAuthCredential> = {};
  constructor(home: string, env: Record<string, string | undefined>) {
    this.path = join(home, "config", ".env");
    for (const [name, value] of Object.entries(env)) {
      if (!name.startsWith(prefix) || !value) continue;
      if (process.env[name] !== undefined)
        throw new Error(`${name} is mutable OAuth state. Configure it only in config/.env so refreshed credentials survive restart without a stale process override.`);
      let candidate: unknown;
      try { candidate = JSON.parse(value); } catch { throw new Error(`Invalid OAuth environment credential ${name}`); }
      if (!validator.Check(candidate)) throw new Error(`Invalid OAuth environment credential ${name}`);
      this.values[name] = candidate as OAuthCredential;
    }
    const references = readers.get(this.path) ?? new Set();
    references.add(new WeakRef(this)); readers.set(this.path, references);
  }
  async read(provider: string, options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    return structuredClone(this.values[nameFor(provider)]);
  }
  async list(options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    return Object.keys(this.values).map(name => ({ providerId: name.slice(prefix.length).toLowerCase().replaceAll("_", "-"), type: "oauth" as const }));
  }
  private publish(name: string, value: OAuthCredential | undefined) {
    const references = readers.get(this.path);
    for (const reference of references ?? []) {
      const store = reference.deref();
      if (!store) { references?.delete(reference); continue; }
      if (value) store.values[name] = structuredClone(value);
      else delete store.values[name];
    }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = (writers.get(this.path) ?? Promise.resolve()).catch(() => {}).then(operation);
    writers.set(this.path, pending);
    void pending.finally(() => { if (writers.get(this.path) === pending) writers.delete(this.path); }).catch(() => {});
    return pending;
  }
  private async save(name: string, value: OAuthCredential | undefined) {
    // Preserve unrelated credentials, deployment settings and comments; replace all duplicate assignments.
    const lines = (optionalText(this.path) ?? "").split(/\r?\n/)
      .filter(line => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1] !== name);
    while (lines.at(-1) === "") lines.pop();
    if (value) lines.push(`${name}=${JSON.stringify(JSON.stringify(value))}`);
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(lines.join("\n") + "\n"); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }
  modify(provider: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions) {
    return this.serialize(async () => {
      options?.signal?.throwIfAborted();
      const name = nameFor(provider);
      const current = this.values[name];
      const next = await fn(structuredClone(current));
      options?.signal?.throwIfAborted();
      if (next !== undefined) {
        if (!validator.Check(next)) throw new Error("CredentialStore accepts only OAuth updates; API keys belong in backend environment variables.");
        await this.save(name, next);
        this.publish(name, next);
      }
      return next ?? structuredClone(current);
    });
  }
  delete(provider: string, options?: AuthOperationOptions) {
    return this.serialize(async () => {
      options?.signal?.throwIfAborted();
      const name = nameFor(provider);
      await this.save(name, undefined);
      this.publish(name, undefined);
    });
  }
}
