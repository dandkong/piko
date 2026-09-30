import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
};
type Conversation = { session: PiSession; touchedAt: number };
type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idleSessionMs = 30 * 60 * 1000;
const maxSessions = 32;
const conversations = new Map<string, Conversation>();
const pendingConversations = new Map<string, Promise<Conversation>>();
const modelRuntimePromise = ModelRuntime.create();

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && sessionIdPattern.test(value);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

async function createConversation(): Promise<Conversation> {
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: [
      "You are Piko, a thoughtful personal assistant.",
      "Be warm, clear, and concise. Help the person think, plan, and write.",
      "You have no tools and no access to their files, accounts, or the internet.",
      "Never claim you completed an action or accessed information you could not reach.",
    ].join("\n"),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    modelRuntime: await modelRuntimePromise,
    sessionManager: SessionManager.inMemory(),
    resourceLoader,
    noTools: "all",
    tools: [],
  });
  if (!session.model) {
    session.dispose();
    throw new Error("No Pi model is configured. Run `pi` and finish setting up a provider and model.");
  }
  return { session, touchedAt: Date.now() };
}

async function getConversation(sessionId: string): Promise<Conversation> {
  const now = Date.now();
  for (const [id, value] of conversations) {
    if (now - value.touchedAt > idleSessionMs && !value.session.isStreaming) {
      value.session.dispose();
      conversations.delete(id);
    }
  }

  const existing = conversations.get(sessionId);
  if (existing) {
    existing.touchedAt = now;
    return existing;
  }
  const pending = pendingConversations.get(sessionId);
  if (pending) {
    const conversation = await pending;
    conversation.touchedAt = Date.now();
    return conversation;
  }

  if (conversations.size + pendingConversations.size >= maxSessions) {
    const oldest = [...conversations.entries()]
      .filter(([, value]) => !value.session.isStreaming)
      .sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
    if (!oldest) throw new Error("Piko is busy with other conversations. Try again shortly.");
    oldest[1].session.dispose();
    conversations.delete(oldest[0]);
  }
  const creation = createConversation()
    .then((created) => {
      conversations.set(sessionId, created);
      return created;
    })
    .finally(() => pendingConversations.delete(sessionId));
  pendingConversations.set(sessionId, creation);
  return creation;
}

function history(conversation?: Conversation): ChatMessage[] {
  if (!conversation) return [];
  return conversation.session.messages.flatMap((message, index) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const content = messageText(message.content);
    if (!content.trim()) return [];
    return [
      {
        id: "id" in message && typeof message.id === "string" ? message.id : `${index}`,
        role: message.role,
        content,
        createdAt: "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : Date.now(),
      },
    ];
  });
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

const defaultDevOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:8081",
  "http://127.0.0.1:8081",
].join(",");
const allowedCorsOrigins = new Set(
  (process.env.PIKO_CORS_ORIGINS ?? (process.env.NODE_ENV === "production" ? "" : defaultDevOrigins))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

function withCors(request: Request, response: Response): Response {
  const origin = request.headers.get("origin");
  if (!origin) return response;
  if (!allowedCorsOrigins.has(origin)) return new Response("Origin not allowed.", { status: 403 });

  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  const vary = headers.get("Vary");
  if (!vary) headers.set("Vary", "Origin");
  else if (!vary.toLowerCase().split(/,\s*/).includes("origin")) headers.set("Vary", `${vary}, Origin`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

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

function chatStream(request: Request, sessionId: string, prompt: string): Response {
  let activeSession: PiSession | undefined;
  let cancelled = false;
  let unsubscribe: (() => void) | undefined;
  const encoder = new TextEncoder();
  const cancel = () => {
    cancelled = true;
    unsubscribe?.();
    if (activeSession?.isStreaming) void activeSession.abort();
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: StreamEvent) => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          cancelled = true;
        }
      };

      void (async () => {
        try {
          const conversation = await getConversation(sessionId);
          if (cancelled) return;
          activeSession = conversation.session;
          if (activeSession.isStreaming) throw new Error("This conversation is already responding.");
          conversation.touchedAt = Date.now();

          let agentError: string | undefined;
          unsubscribe = activeSession.subscribe((event: AgentSessionEvent) => {
            if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
              send({ type: "delta", text: event.assistantMessageEvent.delta });
            } else if (event.type === "message_end" && event.message.role === "assistant") {
              const result = event.message as typeof event.message & { errorMessage?: string; stopReason?: string };
              if (result.stopReason === "error") agentError = result.errorMessage || "Pi could not complete this reply.";
            }
          });

          await activeSession.prompt(prompt);
          if (agentError) send({ type: "error", message: agentError });
          else send({ type: "done" });
          conversation.touchedAt = Date.now();
        } catch (error) {
          send({ type: "error", message: error instanceof Error ? error.message : "Pi could not complete this reply." });
        } finally {
          unsubscribe?.();
          unsubscribe = undefined;
          request.signal.removeEventListener("abort", cancel);
          if (!cancelled) {
            try {
              controller.close();
            } catch {
              // The browser may have closed the stream first.
            }
          }
        }
      })();
    },
    cancel() {
      cancel();
    },
  });

  request.signal.addEventListener("abort", cancel, { once: true });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

const server = Bun.serve({
  hostname: process.env.PIKO_HOST ?? "127.0.0.1",
  port: Number(process.env.PIKO_PORT ?? 8787),
  async fetch(request) {
    if (request.method === "OPTIONS") {
      const origin = request.headers.get("origin");
      if (!origin || !allowedCorsOrigins.has(origin)) return new Response(null, { status: 403 });
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
      const modelReady = (await modelRuntimePromise).getAvailableSnapshot().length > 0;
      return withCors(request, json({
        ok: true,
        app: "Piko",
        runtime: "Pi",
        modelReady,
        activeSessions: conversations.size,
      }));
    }

    const sessionId = sessionFromPath(url.pathname);
    if (sessionId && request.method === "GET") {
      const conversation = conversations.get(sessionId);
      if (conversation) conversation.touchedAt = Date.now();
      return withCors(request, json({ sessionId, messages: history(conversation) }));
    }
    if (sessionId && request.method === "DELETE") {
      const conversation = conversations.get(sessionId);
      conversation?.session.dispose();
      conversations.delete(sessionId);
      return withCors(request, json({ ok: true }));
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      if (Number(request.headers.get("content-length") ?? 0) > 64_000) {
        return withCors(request, json({ error: "Request is too large." }, 413));
      }
      let body: unknown;
      try {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > 64_000) {
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
      if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 12000) {
        return withCors(request, json({ error: "Message must contain 1–12,000 characters." }, 422));
      }
      try {
        const existing = conversations.get(input.sessionId);
        if (existing?.session.isStreaming) return withCors(request, json({ error: "This conversation is already responding." }, 409));
      } catch {
        return withCors(request, json({ error: "Piko is busy. Try again shortly." }, 503));
      }
      return withCors(request, chatStream(request, input.sessionId, input.message.trim()));
    }

    if (url.pathname.startsWith("/api/")) return withCors(request, json({ error: "Not found." }, 404));
    return withCors(request, new Response("Piko API is running. Start the web app with `bun run dev:web`.", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }));
  },
});

console.log(`Piko API listening at http://${server.hostname}:${server.port}`);
console.log("Pi model credentials are read from the Pi agent profile; coding tools are disabled.");
