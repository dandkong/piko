import type { WebFetch } from "../../http";
import { createBraveProvider } from "./brave";
import { createDeepSeekProvider } from "./deepseek";
import { createExaProvider } from "./exa";
import { createTavilyProvider } from "./tavily";
import { SEARCH_PROVIDER_IDS, type ProviderOptions, type SearchProvider, type SearchProviderId } from "../types";

export type SearchCredentials = Partial<Record<SearchProviderId, string | undefined>>;
const creators = {
  exa: createExaProvider,
  tavily: createTavilyProvider,
  deepseek: createDeepSeekProvider,
  brave: createBraveProvider,
} satisfies Record<SearchProviderId, (options: ProviderOptions) => SearchProvider>;

/** Builds only configured providers, in the validated JSON priority order. */
export function createSearchProviders(
  order: readonly SearchProviderId[],
  credentials: SearchCredentials,
  options: { fetch?: WebFetch; timeoutMs?: number } = {},
): SearchProvider[] {
  return order.flatMap(id => {
    const apiKey = credentials[id]?.trim();
    return apiKey ? [creators[id]({ apiKey, ...options })] : [];
  });
}

export function hasSearchCredentials(order: readonly SearchProviderId[], credentials: SearchCredentials) {
  return order.some(id => !!credentials[id]?.trim());
}

export function isSearchProviderId(value: string): value is SearchProviderId {
  return (SEARCH_PROVIDER_IDS as readonly string[]).includes(value);
}
