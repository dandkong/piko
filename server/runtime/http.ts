import type { CompactionResult, RuntimeSelection, ThinkingLevel } from "../../shared/runtime";
import type { ChatRuntime } from "./types";
import { json } from "../http";

const thinking = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export async function runtimeRequest(request: Request, runtime: ChatRuntime,
  change: (operation: () => Promise<void>) => Promise<void> = operation => operation(),
  stop: (commandId?: string) => Promise<boolean> = id => runtime.stop(id)): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/runtime")) return undefined;
  try {
    if (request.method === "GET" && path === "/api/runtime") return json(await runtime.describe());
    if (request.method !== "POST") return json({ error: "Not found." }, 404);
    if (path === "/api/runtime/cancel") { await stop(); return json({ ok: true }); }
    if (path === "/api/runtime/compact") {
      let result!: CompactionResult;
      await change(async () => { result = await runtime.compact(); });
      return json({ ok: true, ...result });
    }
    else if (path === "/api/runtime/selection") {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > 8000) return json({ error: "Request is too large." }, 413);
      let value: unknown;
      try { value = JSON.parse(raw); } catch { return json({ error: "Send a valid JSON body." }, 400); }
      if (!value || typeof value !== "object" || Array.isArray(value)) return json({ error: "Invalid selection." }, 422);
      const choice = value as Record<string, unknown>;
      const fields = Object.keys(choice);
      let selection: RuntimeSelection;
      if (fields.length === 1 && typeof choice.profile === "string" && choice.profile.length > 0 && choice.profile.length < 100) selection = { profile: choice.profile };
      else if (fields.length === 1 && typeof choice.thinking === "string" && thinking.has(choice.thinking)) selection = { thinking: choice.thinking as ThinkingLevel };
      else if (fields.every(key => ["provider", "model", "thinking"].includes(key)) && typeof choice.provider === "string" && choice.provider.length > 0 && choice.provider.length < 100
        && typeof choice.model === "string" && choice.model.length > 0 && choice.model.length < 250
        && (choice.thinking === undefined || typeof choice.thinking === "string" && thinking.has(choice.thinking))) {
        selection = { provider: choice.provider, model: choice.model, ...(choice.thinking && { thinking: choice.thinking as ThinkingLevel }) };
      } else return json({ error: "Invalid model, profile or thinking level." }, 422);
      await change(() => runtime.configure(selection));
    } else return json({ error: "Not found." }, 404);
    return json({ ok: true });
  } catch (error) { return json({ error: error instanceof Error ? error.message : "Runtime configuration failed." }, 409); }
}
