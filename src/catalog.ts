import type { Api, Model, Provider } from "@earendil-works/pi-ai";

/** Providers shipped by pi. Other providers are intentionally labelled as
 * external/managed by the registry because pi does not expose config origin in
 * the runtime Provider object. */
const BUILTIN_PROVIDER_IDS = new Set([
  "amazon-bedrock",
  "anthropic",
  "google",
  "google-vertex",
  "openai",
  "openai-codex",
  "azure-openai-responses",
  "github-copilot",
  "mistral",
  "deepseek",
  "openrouter",
  "xai",
  "groq",
  "cerebras",
  "nvidia",
  "vercel-ai-gateway",
  "zai",
  "zai-coding-cn",
  "minimax",
  "minimax-cn",
  "moonshotai",
  "moonshotai-cn",
  "huggingface",
  "fireworks",
  "together",
  "baseten",
  "opencode",
  "opencode-go",
  "kimi-coding",
  "meta",
  "cloudflare-workers-ai",
  "cloudflare-ai-gateway",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
]);

export type CatalogSource = "builtin" | "plugin" | "registry";

export interface CatalogEntry {
  key: string;
  providerId: string;
  providerName: string;
  model: Model<Api>;
  source: CatalogSource;
  manageable: boolean;
}

export interface CatalogProvider {
  id: string;
  name: string;
  source: CatalogSource;
  manageable: boolean;
  modelCount: number;
}

export interface CatalogSnapshot {
  entries: CatalogEntry[];
  providers: CatalogProvider[];
  providerCount: number;
  lastUpdated: number;
}

export interface ProviderRegistryView {
  getAll(): readonly Model<Api>[];
  getProvider(providerId: string): Provider | undefined;
  getRegisteredProviderIds?(): readonly string[];
}

export function providerSource(providerId: string, managedProviderIds: ReadonlySet<string>): CatalogSource {
  if (managedProviderIds.has(providerId)) return "plugin";
  if (BUILTIN_PROVIDER_IDS.has(providerId)) return "builtin";
  return "registry";
}

export function collectCatalog(
  registry: ProviderRegistryView,
  managedProviderIds: ReadonlySet<string> = new Set(),
): CatalogSnapshot {
  const entries: CatalogEntry[] = [];
  const providers: CatalogProvider[] = [];
  const allModels = registry.getAll();
  const providerIds = new Set<string>(allModels.map((model) => model.provider));
  for (const providerId of registry.getRegisteredProviderIds?.() ?? []) providerIds.add(providerId);

  for (const providerId of providerIds) {
    const provider = registry.getProvider(providerId);
    if (!provider) continue;
    const source = providerSource(provider.id, managedProviderIds);
    const models = allModels.filter((model) => model.provider === provider.id);
    providers.push({
      id: provider.id,
      name: provider.name,
      source,
      manageable: source === "plugin",
      modelCount: models.length,
    });

    for (const model of models) {
      entries.push({
        key: `${provider.id}/${model.id}`,
        providerId: provider.id,
        providerName: provider.name,
        model,
        source,
        manageable: source === "plugin",
      });
    }
  }

  entries.sort((left, right) => {
    const provider = left.providerName.localeCompare(right.providerName);
    return provider || left.model.id.localeCompare(right.model.id);
  });
  providers.sort((left, right) => left.name.localeCompare(right.name));

  return {
    entries,
    providers,
    providerCount: providers.length,
    lastUpdated: Date.now(),
  };
}

export function sourceLabel(source: CatalogSource): string {
  switch (source) {
    case "builtin":
      return "Built-in";
    case "plugin":
      return "Plugin";
    case "registry":
      return "Registry";
    default:
      return "Unknown";
  }
}
