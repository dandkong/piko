import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { ChatRuntime } from "../runtime/types";
import { HttpError, json, readBody } from "../http";
import { SettingsRevisionConflictError, SettingsValidationError } from "./configuration";

const modelSelection = Type.Object({
  provider: Type.String({ minLength: 1, maxLength: 120 }),
  model: Type.String({ minLength: 1, maxLength: 300 }),
  thinking: Type.Optional(Type.Union([
    Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"),
    Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
  ])),
}, { additionalProperties: false });
const profile = Type.Union([Type.Null(), modelSelection]);
const background = Type.Union([
  Type.Object({ mode: Type.Literal("follow-main") }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal("model"), selection: modelSelection }, { additionalProperties: false }),
]);
const credentialOperation = Type.Union([
  Type.Object({
    providerId: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$", maxLength: 120 }),
    action: Type.Literal("set"), key: Type.String({ minLength: 1, maxLength: 8192 }),
  }, { additionalProperties: false }),
  Type.Object({
    providerId: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$", maxLength: 120 }),
    action: Type.Literal("delete"),
  }, { additionalProperties: false }),
]);
const saveSchema = Type.Object({
  baseRevision: Type.String({ minLength: 1, maxLength: 128 }),
  mainModel: profile,
  backgroundModel: background,
  modelDirectory: Type.String({ maxLength: 1_000_000 }),
  credentialOperations: Type.Array(credentialOperation, { maxItems: 64 }),
}, { additionalProperties: false });
const saveValidator = Compile(saveSchema);
const maxBodyBytes = 1_100_000;

function errorResponse(error: unknown) {
  if (error instanceof SettingsRevisionConflictError || error instanceof SettingsValidationError)
    return json({ error: error.message }, error.status);
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  return json({ error: "无法读取或保存设置，请重试。" }, 503);
}

/** Config editing is intentionally unauthenticated during the requested functional-validation phase. */
export async function settingsRequest(
  request: Request,
  runtime: Pick<ChatRuntime, "settings" | "settingsConfiguration" | "saveSettingsConfiguration">,
  restart?: () => void,
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === "/api/settings") {
    if (request.method !== "GET") {
      const response = json({ error: "Use /api/settings/config to edit model settings." }, 405);
      response.headers.set("Allow", "GET");
      return response;
    }
    try { return json(await runtime.settings()); }
    catch { return json({ error: "Could not read settings. Try again later." }, 503); }
  }
  if (path !== "/api/settings/config") return undefined;
  if (request.method === "GET") {
    try { return json(await runtime.settingsConfiguration()); }
    catch (error) { return errorResponse(error); }
  }
  if (request.method !== "PUT") {
    const response = json({ error: "Settings configuration supports GET and PUT." }, 405);
    response.headers.set("Allow", "GET, PUT");
    return response;
  }
  try {
    const bytes = await readBody(request, maxBodyBytes, "设置请求超过 1.1 MB。");
    const text = new TextDecoder().decode(bytes);
    let body: unknown;
    try { body = JSON.parse(text); }
    catch { return json({ error: "设置请求不是有效 JSON。" }, 400); }
    if (!saveValidator.Check(body)) return json({ error: "设置请求字段或结构无效。" }, 400);
    const result = await runtime.saveSettingsConfiguration(body as Parameters<ChatRuntime["saveSettingsConfiguration"]>[0]);
    if (result.restartRequired && restart) setTimeout(restart, 800);
    return json({ ...result, restartScheduled: result.restartRequired && !!restart }, 202);
  } catch (error) { return errorResponse(error); }
}
