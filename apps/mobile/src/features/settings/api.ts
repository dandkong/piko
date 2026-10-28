import type { ModelSettingsSnapshot, SaveModelSettings, SaveModelSettingsResult } from "../../../../../shared/settings";
import { apiFetch, readJson } from "../../api/client";

export async function loadSettings(signal: AbortSignal): Promise<ModelSettingsSnapshot> {
  const response = await apiFetch("/api/settings", { signal });
  if (response.status === 404) throw new Error("设置接口尚未部署，请在更新服务后重试。");
  return readJson<ModelSettingsSnapshot>(response);
}

export async function saveModelSettings(draft: SaveModelSettings): Promise<SaveModelSettingsResult> {
  const response = await apiFetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  return readJson<SaveModelSettingsResult>(response);
}
