import type { WebFetch } from "../../http";
import { createDeepSeekExtractProvider } from "./deepseek";
import { createExaExtractProvider } from "./exa";
import { createFirecrawlProvider } from "./firecrawl";
import type { ProviderCredentials, ProviderRegistry, ProviderRequestOptions, RemoteWebExtractProviderId, WebExtractProvider } from "./types";

const creators = {
  firecrawl: createFirecrawlProvider,
  exa: createExaExtractProvider,
  deepseek: createDeepSeekExtractProvider,
} satisfies Record<RemoteWebExtractProviderId, (options: ProviderRequestOptions) => WebExtractProvider>;

/** Instantiates only remote extractors whose credentials are available at startup. */
export function createWebExtractProviders(
  credentials: ProviderCredentials,
  options: { fetch?: WebFetch; timeoutMs?: number } = {},
): ProviderRegistry {
  const providers = new Map<RemoteWebExtractProviderId, WebExtractProvider>();
  for (const id of ["firecrawl", "exa", "deepseek"] as const) {
    const apiKey = credentials[id]?.trim();
    if (apiKey) providers.set(id, creators[id]({ apiKey, ...options }));
  }
  return providers;
}
