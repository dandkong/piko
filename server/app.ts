import {
  isSessionId,
  type ConversationResponse,
  type HealthResponse,
} from "../shared/chat";
import type { ServerConfig } from "./config";
import type { ChatRuntime } from "./runtime/types";
import type { ConversationStore } from "./chat/conversations";
import { chatStream } from "./chat/stream";
import { json, withCors } from "./http";
import { runtimeRequest } from "./runtime/http";
import { normalizeMessage } from "./chat/input";

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
    if (conversations.unavailableReason && url.pathname.startsWith("/api/")) {
      return withCors(request, json({ error: conversations.unavailableReason }, 503));
    }
    if (url.pathname.startsWith("/api/runtime")) {
      if (request.method === "POST" && url.pathname === "/api/runtime/cancel") {
        const run = await conversations.run(conversations.main.sessionId);
        if (run?.active) {
          try { await run.cancel(); return withCors(request, json({ ok: true })); }
          catch { return withCors(request, json({ error: "Could not stop this reply. Try again." }, 500)); }
        }
      }
      const response = await runtimeRequest(request, runtime, conversations.context(), conversations.isStreaming(conversations.main.sessionId));
      if (response) return withCors(request, response);
    }
    if (request.method === "GET" && url.pathname === "/api/main") {
      return withCors(request, conversations.main ? json(conversations.main) : json({ error: "Main conversation is unavailable." }, 503));
    }
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
    if (sessionId && !conversations.accepts(sessionId)) return withCors(request, json({ error: "This client uses an old conversation. Reload to open the main conversation." }, 409));
    if (sessionId && request.method === "GET") {
      const run = (await conversations.run(sessionId))?.snapshot;
      return withCors(request, json({ sessionId, messages: await conversations.history(sessionId), ...(run && { run }) } satisfies ConversationResponse));
    }
    if (sessionId && request.method === "DELETE") {
      try { conversations.delete(sessionId); }
      catch (error) { return withCors(request, json({ error: (error as Error).message }, 409)); }
      return withCors(request, json({ ok: true }));
    }

    const runPath = /^\/api\/sessions\/([^/]+)\/runs\/([^/]+)\/(events|cancel)$/.exec(url.pathname);
    if (runPath && isSessionId(runPath[1]) && isSessionId(runPath[2])) {
      if (!conversations.accepts(runPath[1])) return withCors(request, json({ error: "Reload to open the main conversation." }, 409));
      const run = await conversations.run(runPath[1], runPath[2]);
      if (!run || run.snapshot.id !== runPath[2]) return withCors(request, json({ error: "Reply is no longer available. Reload the conversation." }, 404));
      if (request.method === "GET" && runPath[3] === "events") {
        const after = Number(url.searchParams.get("after") ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) return withCors(request, json({ error: "A valid event cursor is required." }, 422));
        if (!run.canReplay(after)) return withCors(request, json({ error: "Event history expired. Reload the conversation." }, 409));
        return withCors(request, chatStream(run, request, after));
      }
      if (request.method === "POST" && runPath[3] === "cancel") {
        try { await run.cancel(); }
        catch { return withCors(request, json({ error: "Could not stop this reply. Try again." }, 500)); }
        return withCors(request, json({ run: run.snapshot }));
      }
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
      if (typeof input.message !== "string") {
        return withCors(request, json({ error: "Message must contain 1–12,000 characters." }, 422));
      }
      let message: string;
      try { message = normalizeMessage(input.message); }
      catch (error) { return withCors(request, json({ error: (error as Error).message }, 422)); }
      if (input.runId !== undefined && !isSessionId(input.runId)) return withCors(request, json({ error: "A valid runId is required." }, 422));
      if (input.retryOfRunId !== undefined && !isSessionId(input.retryOfRunId)) return withCors(request, json({ error: "A valid retryOfRunId is required." }, 422));
      const after = input.after ?? 0;
      if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) return withCors(request, json({ error: "A valid event cursor is required." }, 422));
      if (request.signal.aborted) return withCors(request, new Response(null, { status: 499 }));
      try {
        const existing = await conversations.run(input.sessionId, input.runId as string | undefined);
        if (after > 0 && (!existing || existing.snapshot.id !== input.runId || !existing.canReplay(after))) {
          return withCors(request, json({ error: "Event history expired. Reload the conversation." }, 409));
        }
        const run = await conversations.startRun(input.sessionId, (input.runId as string | undefined) ?? crypto.randomUUID(), message, input.retryOfRunId as string | undefined);
        if (!run.canReplay(after)) return withCors(request, json({ error: "Event history expired. Reload the conversation." }, 409));
        return withCors(request, chatStream(run, request, after));
      } catch (error) {
        return withCors(request, json({ error: (error as Error).message }, 409));
      }
    }

    if (url.pathname.startsWith("/api/")) return withCors(request, json({ error: "Not found." }, 404));
    return withCors(request, new Response("Piko API is running. Start the React Native app with `bun run dev`.", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }));
  };
}
