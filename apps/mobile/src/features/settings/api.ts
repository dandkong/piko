import type { SettingsOverview } from "../../../../../shared/settings";
import { apiFetch, readJson } from "../../api/client";

export async function loadSettings(signal: AbortSignal): Promise<SettingsOverview> {
  const response = await apiFetch("/api/settings", { signal });
  if (response.status === 404) throw new Error("设置接口尚未部署，请在更新服务后重试。");
  return readJson<SettingsOverview>(response);
}
