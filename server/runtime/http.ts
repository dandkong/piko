import type { RuntimeSelection, ThinkingLevel } from "../../shared/runtime";
import type { ChatRuntime, SessionContext } from "./types";
import { json } from "../http";

const thinking = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export async function runtimeRequest(request: Request, runtime: ChatRuntime, input: SessionContext, busy: boolean): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/runtime")) return undefined;
  try {
    if (request.method === "GET" && path === "/api/runtime" && runtime.describe) return json(await runtime.describe(input));
    if (request.method !== "POST") return json({ error: "Not found." }, 404);
    if (path === "/api/runtime/cancel" && runtime.stop) { await runtime.stop(input); return json({ ok: true }); }
    if (busy) return json({ error: "Stop the current reply before changing runtime configuration." }, 409);
    if (path === "/api/runtime/reload" && runtime.reload) await runtime.reload(input);
    else if (path === "/api/runtime/compact" && runtime.compact) await runtime.compact(input);
    else if (path === "/api/runtime/selection" && runtime.configure) {
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
      await runtime.configure(input, selection);
    } else return json({ error: "Not found." }, 404);
    return json({ ok: true });
  } catch (error) { return json({ error: error instanceof Error ? error.message : "Runtime configuration failed." }, 409); }
}
