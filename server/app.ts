import { CHAT_PAGE_SIZE, MAX_ATTACHMENTS, MAX_MESSAGE_LENGTH, isHistoryCursor, isRequestId, type HealthResponse } from "../shared/chat";
import type { ServerConfig } from "./config";
import type { ChatRuntime } from "./runtime/types";
import type { ConversationStore } from "./chat/conversations";
import { RuntimeBusyError } from "./runtime/types";
import { chatStream } from "./chat/stream";
import { json, withCors } from "./http";
import { runtimeRequest } from "./runtime/http";
import type { WebHandler } from "./web";
import { itemRequest } from "./items/http";
import { WorkItemError } from "./domain/work-items";
import { AttachmentStore, MAX_ATTACHMENT_BYTES } from "./attachments";
export function createApp({ config, runtime, conversations, attachments, web }: { config: ServerConfig; runtime: ChatRuntime; conversations: ConversationStore; attachments: AttachmentStore; web?: WebHandler }) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const reply = (response: Response) => withCors(request, response);
    if (request.method === "OPTIONS") return reply(new Response(null, { status: 204, headers: { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Accept, Content-Type" } }));
    try {
      if (url.pathname === "/api/attachments" && request.method === "POST") {
        if (Number(request.headers.get("content-length") ?? 0) > MAX_ATTACHMENT_BYTES) return reply(json({ error: "The attachment is too large." }, 413));
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.length > MAX_ATTACHMENT_BYTES) return reply(json({ error: "The attachment is too large." }, 413));
        try {
          const saved = await attachments.save({ bytes, mime: request.headers.get("content-type") ?? undefined });
          return reply(json({ id: saved.id, mime: saved.mime, bytes: saved.bytes, url: `/api/attachments/${saved.id}` }, 201));
        } catch (error) { return reply(json({ error: error instanceof Error ? error.message : "The attachment was rejected." }, 422)); }
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/attachments/")) {
        let id: string;
        try { id = decodeURIComponent(url.pathname.slice("/api/attachments/".length)); }
        catch { return reply(json({ error: "Invalid attachment." }, 400)); }
        const stored = await attachments.read(id);
        if (!stored) return reply(json({ error: "Attachment not found." }, 404));
        return reply(new Response(stored.bytes.slice().buffer, { headers: { "Content-Type": stored.attachment.mime, "Content-Length": String(stored.attachment.bytes),
          "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff",
          ...(!stored.attachment.mime.startsWith("image/") && { "Content-Disposition": "attachment" }) } }));
      }
      if (url.pathname === "/api/items" || url.pathname.startsWith("/api/items/")) return reply(await itemRequest(request, runtime, config.maxRequestBytes));
      if (url.pathname.startsWith("/api/runtime")) {
        const response = await runtimeRequest(request, runtime, operation => conversations.changeRuntime(operation), id => conversations.stop(id));
        if (response) return reply(response);
      }
      if (request.method === "GET" && url.pathname === "/api/health") return reply(json({ ok: true, app: "Piko", runtime: "Pi", modelReady: await runtime.isModelReady(), activeSessions: conversations.size } satisfies HealthResponse));
      if (request.method === "GET" && url.pathname === "/api/chat") return reply(json(await conversations.snapshot({ limit: CHAT_PAGE_SIZE })));
      if (request.method === "GET" && url.pathname === "/api/chat/history") {
        const before = url.searchParams.get("before") ?? undefined;
        if (before !== undefined && !isHistoryCursor(before)) return reply(json({ error: "Invalid history cursor." }, 422));
        return reply(json(await conversations.history(before)));
      }
      if (request.method === "GET" && url.pathname === "/api/chat/events") return reply(chatStream(conversations, request));
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
        const ids = input.attachmentIds === undefined ? [] : input.attachmentIds;
        if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || !ids.every(id => typeof id === "string")) return reply(json({ error: "Invalid attachments." }, 422));
        const paths: string[] = [];
        for (const id of ids as string[]) {
          const stored = await attachments.lookup(id);
          if (!stored) return reply(json({ error: "Attachment not found." }, 422));
          paths.push(stored.path);
        }
        if (typeof input.message !== "string" || input.message.length > MAX_MESSAGE_LENGTH || (!input.message.trim() && !paths.length)) return reply(json({ error: "Message must contain 1–12,000 characters." }, 422));
        return reply(json(await conversations.submit(input.message, input.requestId, undefined, paths)));
      }
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return reply(json({ error: "Not found." }, 404));
      return reply(web ? await web(request) : new Response("Piko API is running."));
    } catch (error) { return reply(json({ error: error instanceof Error ? error.message : "Request failed." }, error instanceof WorkItemError ? error.status : error instanceof RuntimeBusyError ? 409 : 503)); }
  };
}
