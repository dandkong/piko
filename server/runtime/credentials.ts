import { existsSync } from "node:fs";
import { Type } from "typebox";
import type { AuthOperationOptions, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { readJson } from "../config/files";

/**
 * `config/auth.json` uses the Pi credential format: one type-tagged entry per provider id, either
 * `{ type: "api_key", key }` or `{ type: "oauth", refresh, access, expires, … }`.
 * OAuth entries are read as-is; Pi owns refresh, so this store never writes.
 */
const credential = Type.Union([
  Type.Object({
    type: Type.Literal("api_key"),
    key: Type.String({ minLength: 1 }),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
  }, { additionalProperties: true }),
  Type.Object({
    type: Type.Literal("oauth"),
    refresh: Type.String(),
    access: Type.String(),
    expires: Type.Number({ minimum: 0 }),
  }, { additionalProperties: true }),
]);
const storedSchema = Type.Record(Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }), credential);
type StoredCredentials = Record<string, Credential>;

/**
 * Model credentials come only from config/auth.json; the process environment is never consulted.
 * The file is read once at startup, so edits need a restart like the rest of the configuration.
 */
export class StoredCredentialStore implements CredentialStore {
  private readonly values: StoredCredentials;
  constructor(readonly path: string) {
    this.values = existsSync(path) ? readJson(path, storedSchema, {}) : {};
  }
  apiKey(providerId: string) {
    const stored = this.values[providerId];
    return stored?.type === "api_key" ? stored.key : undefined;
  }
  async read(providerId: string, options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    const stored = this.values[providerId];
    return stored ? structuredClone(stored) : undefined;
  }
  async list(options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    return Object.entries(this.values).map(([providerId, value]) => ({ providerId, type: value.type }));
  }
  async modify(): Promise<Credential | undefined> {
    throw new Error(`${this.path} is read-only; edit the file to change credentials.`);
  }
  async delete(): Promise<void> {
    throw new Error(`${this.path} is read-only; remove the entry from ${this.path} instead.`);
  }
}
