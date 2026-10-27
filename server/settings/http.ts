import type { ChatRuntime } from "../runtime/types";
import { json } from "../http";

/** Read-only allowlisted metadata. Config and credential mutations are deliberately not exposed. */
export async function settingsRequest(request: Request, runtime: Pick<ChatRuntime, "settings">): Promise<Response | undefined> {
  if (new URL(request.url).pathname !== "/api/settings") return undefined;
  if (request.method !== "GET") {
    const response = json({ error: "Settings are read-only." }, 405);
    response.headers.set("Allow", "GET");
    return response;
  }
  try {
    return json(await runtime.settings());
  } catch {
    // Upstream provider errors may contain request details; never surface them through this overview.
    return json({ error: "Could not read settings. Try again later." }, 503);
  }
}
