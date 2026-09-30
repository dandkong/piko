import {
  isSessionId,
  MAX_MESSAGE_LENGTH,
  type ConversationResponse,
  type HealthResponse,
} from "../shared/chat";
import type { ServerConfig } from "./config";
import type { ChatRuntime } from "./runtime/types";
import type { ConversationStore } from "./chat/conversations";
import { chatStream } from "./chat/stream";
import { json, withCors } from "./http";

function sessionFromPath(pathname: string): string | undefined {
  const match = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
  if (!match) return undefined;
  try {
    const id = decodeURIComponent(match[1]);
    return isSessionId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

type AppOptions = { config: ServerConfig; runtime: ChatRuntime; conversations: ConversationStore };

/** Construct the handler without opening a port or loading a Pi profile. */
export function createApp({ config, runtime, conversations }: AppOptions) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    if (origin && !config.allowedOrigins.has(origin)) {
      return new Response("Origin not allowed.", { status: 403 });
    }
    if (request.method === "OPTIONS") {
      const origin = request.headers.get("origin");
      if (!origin || !config.allowedOrigins.has(origin)) return new Response(null, { status: 403 });
      return withCors(request, new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Accept, Content-Type",
          "Access-Control-Max-Age": "600",
        },
      }));
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/health") {
      const modelReady = await runtime.isModelReady();
      return withCors(request, json({
        ok: true,
        app: "Piko",
        runtime: "Pi",
        modelReady,
        activeSessions: conversations.size,
      } satisfies HealthResponse));
    }

    const sessionId = sessionFromPath(url.pathname);
    if (sessionId && request.method === "GET") {
      return withCors(request, json({ sessionId, messages: conversations.history(sessionId) } satisfies ConversationResponse));
    }
    if (sessionId && request.method === "DELETE") {
      conversations.delete(sessionId);
      return withCors(request, json({ ok: true }));
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      if (Number(request.headers.get("content-length") ?? 0) > config.maxRequestBytes) {
        return withCors(request, json({ error: "Request is too large." }, 413));
      }
      let body: unknown;
      try {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > config.maxRequestBytes) {
          return withCors(request, json({ error: "Request is too large." }, 413));
        }
        body = JSON.parse(raw);
      } catch {
        return withCors(request, json({ error: "Send a valid JSON body." }, 400));
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return withCors(request, json({ error: "A JSON object is required." }, 400));
      }
      const input = body as Record<string, unknown>;
      if (!isSessionId(input.sessionId)) return withCors(request, json({ error: "A valid sessionId is required." }, 422));
      if (typeof input.message !== "string" || !input.message.trim() || input.message.length > MAX_MESSAGE_LENGTH) {
        return withCors(request, json({ error: "Message must contain 1–12,000 characters." }, 422));
      }
      if (conversations.isStreaming(input.sessionId)) {
        return withCors(request, json({ error: "This conversation is already responding." }, 409));
      }
      return withCors(request, chatStream(conversations, request, input.sessionId, input.message.trim()));
    }

    if (url.pathname.startsWith("/api/")) return withCors(request, json({ error: "Not found." }, 404));
    return withCors(request, new Response("Piko API is running. Start the React Native app with `bun run dev`.", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }));
  };
}
