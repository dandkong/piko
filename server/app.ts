import type { HealthResponse } from "../shared/chat";
import type { ServerConfig } from "./config";
import { RuntimeBusyError, type ChatRuntime } from "./runtime/types";
import type { ConversationStore } from "./chat/conversations";
import type { ConversationStores } from "./chat/stores";
import { SideChatError } from "./runtime/side-chats";
import { AssistantTaskError } from "./domain/tasks";
import { HttpError, json, withCors } from "./http";
import { taskRequest } from "./tasks/http";
import { chatRequest } from "./chat/http";
import { sideChatRequest } from "./side-chats/http";
import { attachmentRequest } from "./attachments/http";
import type { AttachmentStore } from "./attachments";
import { artifactRequest } from "./artifacts/http";
import { settingsRequest } from "./settings/http";
import type { ArtifactStore } from "./artifacts";
import type { WebHandler } from "./web";

export function createApp({
  config,
  runtime,
  conversations,
  chats,
  attachments,
  artifacts,
  web,
  restart,
}: {
  config: ServerConfig;
  runtime: ChatRuntime;
  conversations: ConversationStore;
  chats: ConversationStores;
  attachments: AttachmentStore;
  artifacts: ArtifactStore;
  web?: WebHandler;
  restart?: () => void;
}) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const reply = (response: Response) => withCors(request, response);
    if (request.method === "OPTIONS")
      return reply(
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
        (await settingsRequest(request, runtime, restart)) ??
        (await sideChatRequest(request, runtime, id => chats.forget(id))) ??
        (await attachmentRequest(request, attachments)) ??
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
      if (response) return reply(response);
      if (request.method === "GET" && url.pathname === "/api/health")
        return reply(
          json({
            ok: true,
            app: "Piko",
            runtime: "Pi",
            modelReady: await runtime.isModelReady(),
            activeSessions: conversations.size,
          } satisfies HealthResponse),
        );
      if (url.pathname === "/api" || url.pathname.startsWith("/api/"))
        return reply(json({ error: "Not found." }, 404));
      return reply(
        web ? await web(request) : new Response("Piko API is running."),
      );
    } catch (error) {
      const status =
        error instanceof HttpError ||
        error instanceof AssistantTaskError ||
        error instanceof SideChatError
          ? error.status
          : error instanceof RuntimeBusyError
            ? 409
            : 503;
      return reply(
        json(
          { error: error instanceof Error ? error.message : "Request failed." },
          status,
        ),
      );
    }
  };
}
