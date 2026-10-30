import type { WebFetch } from "../../http";

export const WEB_EXTRACT_PROVIDER_IDS = ["built-in", "firecrawl", "exa", "deepseek"] as const;
export const REMOTE_WEB_EXTRACT_PROVIDER_IDS = ["firecrawl", "exa", "deepseek"] as const;
export type WebExtractProviderId = (typeof WEB_EXTRACT_PROVIDER_IDS)[number];
export type RemoteWebExtractProviderId = (typeof REMOTE_WEB_EXTRACT_PROVIDER_IDS)[number];

export type ProviderResult = {
  title?: string;
  content: string;
  finalUrl?: string;
  siteName?: string;
  byline?: string;
  excerpt?: string;
};
export type WebExtractProvider = {
  id: RemoteWebExtractProviderId;
  extract(url: string, signal?: AbortSignal): Promise<ProviderResult>;
};
export type ProviderRequestOptions = {
  apiKey: string;
  fetch?: WebFetch;
  timeoutMs?: number;
};
export type ProviderCredentials = Partial<Record<RemoteWebExtractProviderId, string | undefined>>;
export type ProviderRegistry = ReadonlyMap<RemoteWebExtractProviderId, WebExtractProvider>;
