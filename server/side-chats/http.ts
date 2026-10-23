import { isRequestId } from "../../shared/chat";
import { SIDE_CHAT_TITLE_LIMIT } from "../../shared/side-chats";
import type { ChatRuntime } from "../runtime/types";
import { json, readObjectBody } from "../http";

export async function sideChatRequest(
  request: Request,
  runtime: ChatRuntime,
  forget?: (id: string) => Promise<void>,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (
    url.pathname === "/api/side-chats" ||
    /^\/api\/side-chats\/[^/]+$/.test(url.pathname)
  ) {
    if (request.method === "GET" && url.pathname === "/api/side-chats")
      return json(await runtime.sideChats.list());
    if (request.method === "DELETE" && url.pathname !== "/api/side-chats") {
      const id = url.pathname.split("/").at(-1)!;
      await runtime.sideChats.remove(id);
      await forget?.(id);
      return new Response(null, { status: 204 });
    }
    if (request.method !== "POST") return json({ error: "Not found." }, 404);
    const input = await readObjectBody(request, 8000);
    if (
      input.title !== undefined &&
      (typeof input.title !== "string" ||
        !input.title.trim() ||
        input.title.trim().length > SIDE_CHAT_TITLE_LIMIT)
    )
      return json({ error: "Invalid side chat title." }, 422);
    if (url.pathname === "/api/side-chats") {
      if (
        !isRequestId(input.requestId) ||
        typeof input.title !== "string" ||
        Object.keys(input).some((key) => !["requestId", "title"].includes(key))
      )
        return json({ error: "A requestId and title are required." }, 422);
      return json(
        await runtime.sideChats.create(input.requestId, input.title),
        201,
      );
    }
    if (
      typeof input.title !== "string" ||
      Object.keys(input).some((key) => key !== "title")
    )
      return json({ error: "Invalid side chat change." }, 422);
    return json(
      await runtime.sideChats.update(url.pathname.split("/").at(-1)!, { title: input.title }),
    );
  }
  return undefined;
}
