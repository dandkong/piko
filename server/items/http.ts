import { isRequestId } from "../../shared/chat";
import type { WorkItemCommand } from "../../shared/work-items";
import { WorkItemError, executionId, itemDraft, itemId } from "../domain/work-items";
import { json } from "../http";
import type { ChatRuntime } from "../runtime/types";

function command(value: unknown): WorkItemCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkItemError("A command object is required.");
  const input = value as Record<string, unknown>;
  if (!isRequestId(input.requestId)) throw new WorkItemError("A requestId is required.");
  const requestId = input.requestId;
  if (input.action === "create") return { action: "create", requestId, item: itemDraft(input.item) };
  const id = itemId(input.id);
  if (input.action === "run") return { action: "run", requestId, id };
  if (input.action === "stop") return { action: "stop", requestId, id };
  if (input.action === "update") return { action: "update", requestId, id, item: itemDraft(input.item) };
  if (input.action === "status" && (input.status === "active" || input.status === "archived")) return { action: "status", requestId, id, status: input.status };
  throw new WorkItemError("Unknown item command.");
}
export async function itemRequest(request: Request, runtime: ChatRuntime, maxBytes: number): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/items") {
    if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw new WorkItemError("Request is too large.", 413);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > maxBytes) throw new WorkItemError("Request is too large.", 413);
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new WorkItemError("Send a valid JSON body.", 400); }
    return json(await (await runtime.workItems()).command(command(value)));
  }
  if (request.method !== "GET") return json({ error: "Not found." }, 404);
  const service = await runtime.workItems();
  const parts = url.pathname.split("/").slice(3);
  try { for (let i = 0; i < parts.length; i++) parts[i] = decodeURIComponent(parts[i]); }
  catch { throw new WorkItemError("Invalid item path."); }
  if (!parts.length) return json({ items: await service.list() });
  const id = itemId(parts[0]);
  if (parts.length === 1) return json(await service.detail(id, url.searchParams.get("before") ?? undefined));
  if (parts[1] === "executions" && parts.length === 3) return json(await service.result(id, executionId(parts[2])));
  return json({ error: "Not found." }, 404);
}
