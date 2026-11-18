import { AttachmentStore, MAX_ATTACHMENT_BYTES } from "../attachments";
import { json, readBody } from "../http";
import { audioPreviewResponse } from "./audio-preview";
import { attachmentTextPreview } from "./text-preview";

export async function attachmentRequest(
  request: Request,
  attachments: AttachmentStore,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname === "/api/attachments" && request.method === "POST") {
    const bytes = await readBody(
      request,
      MAX_ATTACHMENT_BYTES,
      "The attachment is too large.",
    );
    try {
      const saved = await attachments.save({
        bytes,
        name: url.searchParams.get("name") ?? undefined,
        mime: request.headers.get("content-type") ?? undefined,
      });
      return json(
        {
          id: saved.id,
          mime: saved.mime,
          bytes: saved.bytes,
          url: `/api/attachments/${encodeURIComponent(saved.id)}`,
        },
        201,
      );
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error
              ? error.message
              : "The attachment was rejected.",
        },
        422,
      );
    }
  }
  if (
    (request.method === "GET" || (request.method === "HEAD" && url.searchParams.get("play") === "1")) &&
    url.pathname.startsWith("/api/attachments/")
  ) {
    let id: string;
    try {
      id = decodeURIComponent(url.pathname.slice("/api/attachments/".length));
    } catch {
      return json({ error: "Invalid attachment." }, 400);
    }
    const stored = await attachments.read(id);
    if (!stored) return json({ error: "Attachment not found." }, 404);
    if (url.searchParams.get("play") === "1") return audioPreviewResponse(request, stored.bytes, stored.attachment.mime);
    if (url.searchParams.get("preview") === "1") return attachmentTextPreview(id, stored.bytes);
    return new Response(stored.bytes.slice().buffer, {
      headers: {
        "Content-Type": stored.attachment.mime,
        "Content-Length": String(stored.attachment.bytes),
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        ...((url.searchParams.get("download") === "1" || !stored.attachment.mime.startsWith("image/")) && {
          "Content-Disposition": "attachment",
        }),
      },
    });
  }
  return undefined;
}
