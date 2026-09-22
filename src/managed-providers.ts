import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Providers managed by this extension.
 *
 * Registration deliberately uses Pi's legacy provider-config form
 * (`pi.registerProvider(id, config)`) instead of `createProvider()` from
 * `@earendil-works/pi-ai`. Pi only aliases a fixed set of bare specifiers for
 * extensions, so `@earendil-works/pi-ai/api/*` subpaths fail to resolve in an
 * installed package, and the config form lets Pi resolve the API
 * implementation itself.
 */

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
  /** API root, e.g. `https://api.example.com/v1`. */
  baseUrl: string;
  /** Override the discovery path. Absolute URLs are used as-is. */
  modelsPath?: string;
  /** Extra headers sent on chat and discovery requests. */
  headers?: Record<string, string>;
}

export interface ManagedModelDefinition {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export interface ManagedProviderRegistration {
  name: string;
  baseUrl: string;
  api: ManagedApi;
  headers?: Record<string, string>;
  refreshModels(context: RefreshModelsContext): Promise<ManagedModelDefinition[]>;
}

const CONFIG_FILE = "pi-model-manager.json";
const DEFAULT_CONTEXT = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const ANTHROPIC_VERSION = "2023-06-01";

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

function trimSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

/**
 * Anthropic's model list lives at `/v1/models`, but its API root in Pi's
 * models.json is usually the bare host. Insert `/v1` only when the configured
 * URL has no path of its own, so custom gateway paths are preserved.
 */
/**
 * Builds the discovery URL from a chat API root.
 *
 * The base URL Pi stores is the same value handed to the provider SDK, so the
 * API path each SDK appends decides where discovery lives:
 *
 * - Anthropic Messages: the SDK appends `/v1/messages`, so discovery is
 *   `${baseUrl}/v1/models` even for gateway paths (`.../anthropic`), matching
 *   built-in roots such as `https://api.anthropic.com` and
 *   `https://api.minimax.io/anthropic`.
 * - OpenAI Completions/Responses: the SDK appends `/chat/completions` but no
 *   version segment, so discovery appends `/models` to the base URL as-is.
 * - Google: the base URL already carries `/v1beta`, so discovery appends
 *   `/models` as-is.
 */
export function modelsUrl(config: ManagedProviderConfig): string {
  const override = config.modelsPath?.trim();
  if (override && /^https?:\/\//u.test(override)) return override;

  const base = trimSlashes(config.baseUrl);
  if (override) return `${base}/${override.replace(/^\/+/u, "")}`;

  if (config.api === "anthropic-messages") {
    const versioned = /\/v1$/u.test(base) ? base : `${base}/v1`;
    return `${versioned}/models`;
  }
  return `${base}/models`;
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

function nameField(record: Record<string, unknown>): string | undefined {
  for (const key of ["display_name", "displayName", "name"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function modalities(record: Record<string, unknown>): string[] {
  for (const key of ["input", "input_modalities", "modalities"]) {
    const value = record[key];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function rawModelId(record: Record<string, unknown>): string | undefined {
  const value = record.id ?? record.model ?? record.name;
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.startsWith("models/") ? value.slice("models/".length) : value;
}

function modelFromRecord(record: Record<string, unknown>): ManagedModelDefinition | undefined {
  const id = rawModelId(record);
  if (!id) return undefined;

  const declared = modalities(record);
  const name = nameField(record) ?? id;
  // Only trust explicit metadata or an unambiguous ID marker. A wrong guess
  // here silently changes what Pi sends, so the defaults stay conservative.
  const reasoning = Boolean(record.reasoning ?? record.supports_reasoning) || /(?:reasoning|thinking|-r1(?:-|$))/iu.test(id);
  const image = declared.some((item) => /image|vision/iu.test(item)) || /vision|image/iu.test(id);

  return {
    id,
    name: name.startsWith("models/") ? name.slice("models/".length) : name,
    reasoning,
    input: image ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: numberField(record, "contextWindow", "context_window", "inputTokenLimit", "input_token_limit") ?? DEFAULT_CONTEXT,
    maxTokens: numberField(record, "maxTokens", "max_tokens", "outputTokenLimit", "output_token_limit") ?? DEFAULT_MAX_TOKENS,
  };
}

export function parseDiscoveredModels(payload: unknown): ManagedModelDefinition[] {
  const root = asRecord(payload);
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(root.data)
      ? root.data
      : Array.isArray(root.models)
        ? root.models
        : [];

  const seen = new Set<string>();
  const models: ManagedModelDefinition[] = [];
  for (const entry of raw) {
    const model = modelFromRecord(asRecord(entry));
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models.sort((left, right) => left.id.localeCompare(right.id));
}

function discoveryHeaders(config: ManagedProviderConfig, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { ...config.headers };
  switch (config.api) {
    case "anthropic-messages":
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = ANTHROPIC_VERSION;
      break;
    case "google-generative-ai":
      headers["x-goog-api-key"] = apiKey;
      break;
    default:
      headers.Authorization = `Bearer ${apiKey}`;
      break;
  }
  return headers;
}

export async function discoverModels(
  config: ManagedProviderConfig,
  apiKey: string,
  signal: AbortSignal,
): Promise<ManagedModelDefinition[]> {
  const url = modelsUrl(config);
  const response = await fetch(url, { headers: discoveryHeaders(config, apiKey), signal });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
    throw new Error(`${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`);
  }
  return parseDiscoveredModels(await response.json());
}

function storedKey(context: RefreshModelsContext): string | undefined {
  const credential = context.credential;
  if (credential?.type !== "api_key") return undefined;
  const key = credential.key?.trim();
  return key ? key : undefined;
}

/** Widens a definition into the full model shape the catalog store persists. */
function toPiModel(config: ManagedProviderConfig, definition: ManagedModelDefinition): Model<ManagedApi> {
  return {
    ...definition,
    api: config.api,
    provider: config.id,
    baseUrl: config.baseUrl,
  };
}

/** Narrows a persisted model back into the definition Pi expects from extensions. */
function fromPiModel(model: Model<Api>): ManagedModelDefinition {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

/**
 * Last successful discovery per provider, for the current process.
 *
 * Pi replaces a provider's extension models with whatever `refreshModels`
 * returns, so returning an empty list on an offline or failed pass would erase
 * models the user can still chat with.
 */
const lastKnownModels = new Map<string, ManagedModelDefinition[]>();

/**
 * Builds the config object passed to `pi.registerProvider(id, config)`.
 *
 * Auth is intentionally not declared here: Pi fabricates a generic API-key
 * login for extension providers that omit `apiKey`/`oauth`, so the credential
 * lives in `auth.json` via `/login` instead of in this extension's config.
 *
 * Refresh follows Pi's dynamic-provider contract: restore the persisted
 * catalog first, only touch the network when `allowNetwork` permits it, and
 * publish successful discoveries so they survive a restart. Pi's startup pass
 * is cache-only, so a provider that never persists would look empty on every
 * launch until something forced a network refresh.
 */
export function buildManagedProvider(config: ManagedProviderConfig): ManagedProviderRegistration {
  const restore = (context: RefreshModelsContext): ManagedModelDefinition[] | undefined => {
    const stored = context.stored?.models.filter((model) => model.provider === config.id);
    if (!stored || stored.length === 0) return undefined;
    return stored.map(fromPiModel);
  };

  return {
    name: config.name,
    api: config.api,
    baseUrl: config.baseUrl,
    headers: config.headers,
    async refreshModels(context) {
      const restored = restore(context);
      // `--offline` and cache-only startup forbid network access.
      if (!context.allowNetwork || context.signal.aborted) {
        return restored ?? lastKnownModels.get(config.id) ?? [];
      }
      // Refresh also runs before `/login`; an unauthenticated provider keeps
      // whatever it had instead of reporting a misleading failure.
      const apiKey = storedKey(context);
      if (!apiKey) return restored ?? lastKnownModels.get(config.id) ?? [];

      const models = await discoverModels(config, apiKey, context.signal);
      if (context.signal.aborted) return restored ?? [];
      lastKnownModels.set(config.id, models);
      await context.publish({
        persist: { models: models.map((definition) => toPiModel(config, definition)), checkedAt: Date.now() },
      });
      return models;
    },
  };
}

export function managedProviderIds(configs: readonly ManagedProviderConfig[]): Set<string> {
  return new Set(configs.map((config) => config.id));
}
