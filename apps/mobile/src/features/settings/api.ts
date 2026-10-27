import type {
  SaveSettingsConfiguration, SaveSettingsResult, SettingsConfigurationSnapshot, SettingsOverview,
} from "../../../../../shared/settings";
import { apiFetch, readJson } from "../../api/client";

export async function loadSettings(signal: AbortSignal): Promise<SettingsOverview> {
  const response = await apiFetch("/api/settings", { signal });
  if (response.status === 404) throw new Error("设置接口尚未部署，请在更新服务后重试。");
  return readJson<SettingsOverview>(response);
}

export async function loadSettingsConfiguration(signal?: AbortSignal): Promise<SettingsConfigurationSnapshot> {
  const response = await apiFetch("/api/settings/config", { signal });
  if (response.status === 404) throw new Error("设置管理接口尚未部署，请更新服务后重试。");
  return readJson<SettingsConfigurationSnapshot>(response);
}

export async function saveSettingsConfiguration(draft: SaveSettingsConfiguration): Promise<SaveSettingsResult & { restartScheduled?: boolean }> {
  const response = await apiFetch("/api/settings/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  return readJson<SaveSettingsResult & { restartScheduled?: boolean }>(response);
}
