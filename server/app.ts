import { MAX_MESSAGE_LENGTH, isRequestId, type HealthResponse } from "../shared/chat";
import type { ServerConfig } from "./config";
import type { ChatRuntime } from "./runtime/types";
import type { ConversationStore } from "./chat/conversations";
import { RuntimeBusyError } from "./chat/conversations";
import { chatStream } from "./chat/stream";
import { json, withCors } from "./http";
import { runtimeRequest } from "./runtime/http";
export function createApp({ config, runtime, conversations }: { config: ServerConfig; runtime: ChatRuntime; conversations: ConversationStore }) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    if (origin && !config.allowedOrigins.has(origin)) return new Response("Origin not allowed.", { status: 403 });
    const reply = (response: Response) => withCors(request, response);
    if (request.method === "OPTIONS") return reply(new Response(null, { status: 204, headers: { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Accept, Content-Type" } }));
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/runtime")) {
        const response = await runtimeRequest(request, runtime, conversations.isStreaming(), operation => conversations.changeRuntime(operation), id => conversations.stop(id));
        if (response) return reply(response);
      }
      if (request.method === "GET" && url.pathname === "/api/health") return reply(json({ ok: true, app: "Piko", runtime: "Pi", modelReady: await runtime.isModelReady(), activeSessions: conversations.size } satisfies HealthResponse));
      if (request.method === "GET" && url.pathname === "/api/chat") return reply(json(await conversations.snapshot()));
      if (request.method === "GET" && url.pathname === "/api/chat/events") {
        const after = Number(url.searchParams.get("after") ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) return reply(json({ error: "Invalid event cursor." }, 422));
        return reply(chatStream(conversations, request, url.searchParams.get("epoch") ?? undefined, after));
      }
      if (request.method === "GET" && url.pathname === "/api/chat/submission") {
        const id = url.searchParams.get("requestId");
        if (!isRequestId(id)) return reply(json({ error: "A requestId is required." }, 422));
        const result = await (await conversations.get()).submission(id);
        return reply(result ? json(result) : json({ error: "Submission not found." }, 404));
      }
      if (request.method === "POST" && (url.pathname === "/api/chat" || url.pathname === "/api/chat/stop")) {
        if (Number(request.headers.get("content-length") ?? 0) > config.maxRequestBytes) return reply(json({ error: "Request is too large." }, 413));
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > config.maxRequestBytes) return reply(json({ error: "Request is too large." }, 413));
        let value: unknown; try { value = JSON.parse(raw); } catch { return reply(json({ error: "Send a valid JSON body." }, 400)); }
        if (!value || typeof value !== "object" || Array.isArray(value)) return reply(json({ error: "A JSON object is required." }, 422));
        const input = value as Record<string, unknown>;
        if (!isRequestId(input.requestId)) return reply(json({ error: "A requestId is required." }, 422));
        if (request.signal.aborted) return reply(new Response(null, { status: 499 }));
        if (url.pathname.endsWith("/stop")) return reply(json({ ok: true, stopped: await conversations.stop(input.requestId) }));
        if (typeof input.message !== "string" || !input.message.trim() || input.message.length > MAX_MESSAGE_LENGTH) return reply(json({ error: "Message must contain 1–12,000 characters." }, 422));
        return reply(json(await conversations.submit(input.message, input.requestId)));
      }
      return reply(url.pathname.startsWith("/api/") ? json({ error: "Not found." }, 404) : new Response("Piko API is running."));
    } catch (error) { return reply(json({ error: error instanceof Error ? error.message : "Request failed." }, error instanceof RuntimeBusyError ? 409 : 503)); }
  };
}
