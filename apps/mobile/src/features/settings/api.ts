import type { ModelSettingsSnapshot, SaveModelSettings, SaveModelSettingsResult } from "../../../../../shared/settings";
import { apiFetch, readJson } from "../../api/client";
import { ApiError } from "../../api/errors";

export async function loadSettings(signal: AbortSignal): Promise<ModelSettingsSnapshot> {
  const response = await apiFetch("/api/settings", { signal });
  try { return await readJson<ModelSettingsSnapshot>(response); }
  catch (cause) {
    if (cause instanceof ApiError && cause.status === 404)
      throw new ApiError("设置接口尚未部署，请在更新服务后重试。", 404);
    throw cause;
  }
}

export async function saveModelSettings(draft: SaveModelSettings): Promise<SaveModelSettingsResult> {
  const response = await apiFetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  return readJson<SaveModelSettingsResult>(response);
}
