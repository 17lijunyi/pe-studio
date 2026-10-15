import type { Connection, Protocol } from "./types";
import { AIHUBMIX_BACKUP_BASE_URL, AIHUBMIX_BASE_URL, AIHUBMIX_RECOMMENDED_MODELS, normalizeAiHubMixBase } from "./aihubmix";

export type CloudProviderId = "aihubmix" | "deepseek";
export type CloudProtocol = "aihubmix" | "deepseek";
export interface CloudProviderDefinition {
  id: CloudProviderId;
  label: string;
  protocol: CloudProtocol;
  defaultBaseUrl: string;
  docsUrl: string;
  recommendedModels: readonly string[];
}

/** Suggestions only: fetched directory IDs and manually entered IDs remain authoritative. */
export const CLOUD_PROVIDERS: readonly CloudProviderDefinition[] = [
  { id: "aihubmix", label: "推理时代 · AiHubMix", protocol: "aihubmix", defaultBaseUrl: AIHUBMIX_BASE_URL, docsUrl: "https://docs.aihubmix.com/", recommendedModels: AIHUBMIX_RECOMMENDED_MODELS },
  { id: "deepseek", label: "DeepSeek", protocol: "deepseek", defaultBaseUrl: "https://api.deepseek.com", docsUrl: "https://api-docs.deepseek.com/", recommendedModels: ["deepseek-flash", "deepseek-v4-pro"] },
];

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_TIMEOUT_MS = 180_000;
export const MODEL_CATALOG_TIMEOUT_MS = 10_000;
export const MODEL_CATALOG_MAX_ENTRIES = 2_000;

export function normalizeDeepSeekBase(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/chat/completions") ? path.slice(0, -"/chat/completions".length) || "/" : path || "/";
  return url.toString().replace(/\/+$/, "");
}

/** Identifies existing connections without rewriting their protocol, model, URL or key. */
export function providerForConnection(connection: Pick<Connection, "protocol" | "baseUrl">): CloudProviderDefinition | undefined {
  if (connection.protocol === "aihubmix" || connection.protocol === "deepseek") return CLOUD_PROVIDERS.find(provider => provider.protocol === connection.protocol);
  if (connection.protocol !== "openai-compatible") return undefined;
  try {
    const base = normalizeAiHubMixBase(connection.baseUrl);
    if ([AIHUBMIX_BASE_URL, AIHUBMIX_BACKUP_BASE_URL].includes(base)) return CLOUD_PROVIDERS[0];
    if ([DEEPSEEK_BASE_URL, `${DEEPSEEK_BASE_URL}/v1`].includes(normalizeDeepSeekBase(connection.baseUrl))) return CLOUD_PROVIDERS[1];
  } catch { /* Unknown legacy/custom connections are left intact. */ }
  return undefined;
}

export interface ModelCatalogConnection { protocol: Protocol; baseUrl: string; apiKey: string }
export interface ModelCatalogEntry { id: string; displayName?: string; ownedBy?: string }
export type ModelCatalogResult =
  | { ok: true; provider: CloudProviderId; models: ModelCatalogEntry[]; latencyMs: number }
  | { ok: false; error: string };
