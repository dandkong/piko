import { isRequestId } from "../../shared/chat";
import type { AssistantTaskCommand } from "../../shared/tasks";
import { AssistantTaskError, executionId, taskDraft, taskId } from "../domain/tasks";
import { json } from "../http";
import type { ChatRuntime } from "../runtime/types";

function command(value: unknown): AssistantTaskCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantTaskError("A command object is required.");
  const input = value as Record<string, unknown>;
  if (!isRequestId(input.requestId)) throw new AssistantTaskError("A requestId is required.");
  const requestId = input.requestId;
  if (input.action === "create") return { action: "create", requestId, task: taskDraft(input.task) };
  const id = taskId(input.id);
  if (input.action === "run") return { action: "run", requestId, id };
  if (input.action === "stop") return { action: "stop", requestId, id };
  if (input.action === "update") return { action: "update", requestId, id, task: taskDraft(input.task) };
  if (input.action === "status" && (input.status === "active" || input.status === "archived")) return { action: "status", requestId, id, status: input.status };
  throw new AssistantTaskError("Unknown task command.");
}
export async function taskRequest(request: Request, runtime: ChatRuntime, maxBytes: number): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/tasks") {
    if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw new AssistantTaskError("Request is too large.", 413);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > maxBytes) throw new AssistantTaskError("Request is too large.", 413);
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new AssistantTaskError("Send a valid JSON body.", 400); }
    return json(await (await runtime.tasks()).command(command(value)));
  }
  if (request.method !== "GET") return json({ error: "Not found." }, 404);
  const service = await runtime.tasks();
  const parts = url.pathname.split("/").slice(3);
  try { for (let i = 0; i < parts.length; i++) parts[i] = decodeURIComponent(parts[i]); }
  catch { throw new AssistantTaskError("Invalid task path."); }
  if (!parts.length) return json({ tasks: await service.list() });
  const id = taskId(parts[0]);
  if (parts.length === 1) return json(await service.detail(id, url.searchParams.get("before") ?? undefined));
  if (parts[1] === "executions" && parts.length === 3) return json(await service.result(id, executionId(parts[2])));
  return json({ error: "Not found." }, 404);
}
