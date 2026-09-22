import {
  createProvider,
  type Model,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const SUPPORTED_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

export type ManagedApi = (typeof SUPPORTED_APIS)[number];

export interface ManagedProviderConfig {
  id: string;
  name: string;
  api: ManagedApi;
  baseUrl: string;
  modelsPath?: string;
  headers?: Record<string, string>;
}

const CONFIG_FILE = "pi-model-manager.json";
const DEFAULT_CONTEXT = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

function configPath(): string {
  return join(getAgentDir(), CONFIG_FILE);
}

function isApi(value: unknown): value is ManagedApi {
  return typeof value === "string" && (SUPPORTED_APIS as readonly string[]).includes(value);
}

function isConfig(value: unknown): value is ManagedProviderConfig {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.startsWith("pi-auto-") &&
    typeof record.name === "string" &&
    isApi(record.api) &&
    typeof record.baseUrl === "string" &&
    record.baseUrl.length > 0
  );
}

export function loadManagedProviders(): ManagedProviderConfig[] {
  const path = configPath();
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isConfig);
  } catch {
    return [];
  }
}

export function saveManagedProviders(configs: readonly ManagedProviderConfig[]): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(configs, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function upsertManagedProvider(
  configs: readonly ManagedProviderConfig[],
  config: ManagedProviderConfig,
): ManagedProviderConfig[] {
  const next = configs.filter((item) => item.id !== config.id);
  next.push(config);
  return next.sort((left, right) => left.name.localeCompare(right.name));
}

function modelsUrl(config: ManagedProviderConfig): string {
  const path = config.modelsPath?.trim() || "/models";
  if (/^https?:\/\//u.test(path)) return path;
  return `${config.baseUrl.replace(/\/$/u, "")}/${path.replace(/^\//u, "")}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function stringArrayField(record: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function modelId(record: Record<string, unknown>): string | undefined {
  const id = record.id ?? record.name ?? record.model;
  if (typeof id !== "string" || id.length === 0) return undefined;
  return id.startsWith("models/") ? id.slice("models/".length) : id;
}

function modelFromRecord(record: Record<string, unknown>, config: ManagedProviderConfig): Model<ManagedApi> | undefined {
  const id = modelId(record);
  if (!id) return undefined;

  const name = typeof record.display_name === "string"
    ? record.display_name
    : typeof record.displayName === "string"
      ? record.displayName
      : id;
  const modalities = stringArrayField(record, "input", "input_modalities", "modalities");
  const supportedMethods = stringArrayField(record, "supportedGenerationMethods");
  const reasoning = Boolean(record.reasoning ?? record.supports_reasoning) || /(?:reasoning|thinking|deepseek-r1|o[1-9])/iu.test(id);
  const image = modalities.some((item) => /image|vision/iu.test(item)) || /vision|image/iu.test(id);
  const contextWindow = numberField(record, "contextWindow", "context_window", "inputTokenLimit", "input_token_limit") ?? DEFAULT_CONTEXT;
  const maxTokens = numberField(record, "maxTokens", "max_tokens", "outputTokenLimit", "output_token_limit") ?? DEFAULT_MAX_TOKENS;

  return {
    id,
    name,
    api: config.api,
    provider: config.id,
    baseUrl: config.baseUrl,
    reasoning,
    input: image ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    compat: config.api === "openai-completions" && supportedMethods.includes("developer")
      ? { supportsDeveloperRole: true }
      : undefined,
  } as Model<ManagedApi>;
}

export function parseDiscoveredModels(payload: unknown, config: ManagedProviderConfig): Model<ManagedApi>[] {
  const root = asRecord(payload);
  const rawModels = Array.isArray(payload)
    ? payload
    : Array.isArray(root.data)
      ? root.data
      : Array.isArray(root.models)
        ? root.models
        : [];
  const seen = new Set<string>();
  const models: Model<ManagedApi>[] = [];
  for (const raw of rawModels) {
    const model = modelFromRecord(asRecord(raw), config);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

function apiStreams(api: ManagedApi): ProviderStreams {
  switch (api) {
    case "openai-completions":
      return openAICompletionsApi();
    case "openai-responses":
      return openAIResponsesApi();
    case "anthropic-messages":
      return anthropicMessagesApi();
    case "google-generative-ai":
      return googleGenerativeAIApi();
    default:
      throw new Error(`Unsupported API: ${api satisfies never}`);
  }
}

export function createManagedProvider(config: ManagedProviderConfig): Provider<ManagedApi> {
  return createProvider({
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    headers: config.headers,
    auth: {
      apiKey: {
        name: `${config.name} API key`,
        async login(interaction) {
          return {
            type: "api_key",
            key: await interaction.prompt({ type: "secret", message: `Enter API key for ${config.name}` }),
          };
        },
        async resolve({ credential }) {
          return credential?.key
            ? { auth: { apiKey: credential.key }, source: "stored API key" }
            : undefined;
        },
      },
    },
    models: [],
    api: apiStreams(config.api),
    fetchModels: async ({ credential, signal }) => {
      if (!credential || credential.type !== "api_key" || !credential.key) {
        throw new Error("Provider is not authenticated; run /login first");
      }
      const headers = new Headers(config.headers);
      if (config.api === "google-generative-ai") headers.set("x-goog-api-key", credential.key);
      else headers.set("Authorization", `Bearer ${credential.key}`);
      const response = await fetch(modelsUrl(config), { headers, signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} while fetching models`);
      return parseDiscoveredModels(await response.json(), config);
    },
  });
}

export function managedProviderIds(configs: readonly ManagedProviderConfig[]): Set<string> {
  return new Set(configs.map((config) => config.id));
}
