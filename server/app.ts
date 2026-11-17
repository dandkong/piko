import type { HealthResponse } from "../shared/chat";
import type { ServerConfig } from "./config";
import { ModelConfigurationError, RuntimeBusyError, StorageDeletionBlocked, type ChatRuntime } from "./runtime/types";
import type { ConversationStore } from "./chat/conversations";
import type { ConversationStores } from "./chat/stores";
import { SideChatError } from "./runtime/side-chats";
import { AssistantTaskError } from "./domain/tasks";
import { HttpError, json, withCors } from "./http";
import { taskRequest } from "./tasks/http";
import { postRequest } from "./posts/http";
import { PostError } from "./domain/posts";
import { chatRequest } from "./chat/http";
import { sideChatRequest } from "./side-chats/http";
import { attachmentRequest } from "./attachments/http";
import { sentAttachmentRequest } from "./attachments/sent-http";
import type { AttachmentStore } from "./attachments";
import { artifactRequest } from "./artifacts/http";
import { settingsRequest } from "./settings/http";
import type { ArtifactStore } from "./artifacts";
import type { WebHandler } from "./web";
import { logError, logInfo, logWarn } from "./logging";

export function createApp({
  config,
  runtime,
  conversations,
  chats,
  attachments,
  artifacts,
  web,
}: {
  config: ServerConfig;
  runtime: ChatRuntime;
  conversations: ConversationStore;
  chats: ConversationStores;
  attachments: AttachmentStore;
  artifacts: ArtifactStore;
  web?: WebHandler;
}) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const reply = (response: Response) => withCors(request, response);
    const startedAt = performance.now();
    const shouldLog = url.pathname.startsWith("/api") &&
      request.method !== "OPTIONS" && !url.pathname.endsWith("/events");
    const finish = (response: Response) => {
      const result = reply(response);
      if (shouldLog && (request.method !== "GET" || result.status >= 400)) {
        const fields = {
          method: request.method,
          route: url.pathname,
          status: result.status,
          durationMs: Math.round(performance.now() - startedAt),
        };
        if (result.status >= 500) logError("http.request.failed", fields);
        else if (result.status >= 400) logWarn("http.request.rejected", fields);
        else logInfo("http.request.completed", fields);
      }
      return result;
    };
    if (request.method === "OPTIONS")
      return finish(
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Accept, Content-Type",
          },
        }),
      );
    try {
      const response =
        (await postRequest(request, runtime, config.maxRequestBytes)) ??
        (await settingsRequest(request, runtime)) ??
        (await sideChatRequest(request, runtime, id => chats.forget(id))) ??
        (await attachmentRequest(request, attachments)) ??
        (await sentAttachmentRequest(request, attachments)) ??
        (await artifactRequest(request, artifacts)) ??
        (url.pathname === "/api/tasks" || url.pathname.startsWith("/api/tasks/")
          ? await taskRequest(request, runtime, config.maxRequestBytes)
          : undefined) ??
        (await chatRequest(
          request,
          chats,
          attachments,
          config.maxRequestBytes,
        ));
      if (response) return finish(response);
      if (request.method === "GET" && url.pathname === "/api/health")
        return finish(
          json({
            ok: true,
            app: "Piko",
            runtime: "Pi",
            modelReady: await runtime.isModelReady(),
            activeSessions: conversations.size,
          } satisfies HealthResponse),
        );
      if (url.pathname === "/api" || url.pathname.startsWith("/api/"))
        return finish(json({ error: "Not found." }, 404));
      return finish(
        web ? await web(request) : new Response("Piko API is running."),
      );
    } catch (error) {
      const status =
        error instanceof HttpError ||
        error instanceof AssistantTaskError || error instanceof PostError ||
        error instanceof SideChatError || error instanceof ModelConfigurationError || error instanceof StorageDeletionBlocked
          ? error.status
          : error instanceof RuntimeBusyError
            ? 409
            : 503;
      const code = error instanceof ModelConfigurationError ? "model_unavailable"
        : error instanceof RuntimeBusyError ? "runtime_busy"
          : error instanceof PostError ? error.code
            : error instanceof StorageDeletionBlocked ? "deletion_blocked" : undefined;
      return finish(json({
        error: status >= 500 ? "服务暂时不可用，请稍后重试。" : error instanceof Error ? error.message : "请求未完成。",
        ...(code && { code }),
      }, status));
    }
  };
}
