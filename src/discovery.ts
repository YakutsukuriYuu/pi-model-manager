import type { ModelEntry } from "./models-json.ts";

/**
 * Model discovery for a configured provider.
 *
 * Values come from three sources, in this order of trust:
 *
 * 1. `upstream` — what the provider's own model list actually reported.
 * 2. `catalog`  — Pi's built-in catalog, used only to fill fields the upstream
 *    stayed silent about. It describes the vendor's native model, which a
 *    gateway may cap lower, so it never overrides a reported value.
 * 3. `guess`    — a capability inferred from the model id. Always surfaced as
 *    a guess in the UI because it is not a claim from anyone.
 */

export const SUPPORTED_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

export type ProviderApi = (typeof SUPPORTED_APIS)[number];

/** A model as Pi currently knows it, including built-in catalog entries. */
export interface CatalogModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  image?: boolean;
}

export type FieldSource = "upstream" | "catalog" | "guess";

export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  image?: boolean;
  /** Provenance per field; an absent entry means "not determined". */
  sources: Partial<Record<"name" | "contextWindow" | "maxTokens" | "reasoning" | "image", FieldSource>>;
}

export interface DiscoveryTarget {
  baseUrl: string;
  api: ProviderApi;
  apiKey: string;
  headers?: Record<string, string>;
}

export type ExistingState = "new" | "same" | "differs";

const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Builds the discovery URL from the chat API root.
 *
 * The base URL is the same value handed to the provider SDK, so the path each
 * SDK appends decides where discovery lives:
 *
 * - Anthropic Messages: the SDK appends `/v1/messages`, so discovery is
 *   `${baseUrl}/v1/models`, including for gateway paths. Built-in roots such
 *   as `https://api.anthropic.com` and `https://api.minimax.io/anthropic`
 *   carry no version segment themselves.
 * - OpenAI Completions/Responses: the SDK appends no version segment, so
 *   discovery appends `/models` to the base URL as-is.
 * - Google: the base URL already carries `/v1beta`, so `/models` is appended.
 */
export function modelsUrl(baseUrl: string, api: ProviderApi): string {
  const base = baseUrl.replace(/\/+$/u, "");
  if (api === "anthropic-messages") {
    const versioned = /\/v1$/u.test(base) ? base : `${base}/v1`;
    return `${versioned}/models`;
  }
  return `${base}/models`;
}

function authHeaders(target: DiscoveryTarget): Record<string, string> {
  const headers: Record<string, string> = { ...target.headers };
  switch (target.api) {
    case "anthropic-messages":
      headers["x-api-key"] = target.apiKey;
      headers["anthropic-version"] = ANTHROPIC_VERSION;
      break;
    case "google-generative-ai":
      headers["x-goog-api-key"] = target.apiKey;
      break;
    default:
      headers.Authorization = `Bearer ${target.apiKey}`;
      break;
  }
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function nestedPositiveNumber(record: Record<string, unknown>, parent: string, keys: string[]): number | undefined {
  const child = record[parent];
  return isRecord(child) ? positiveNumber(child, keys) : undefined;
}

function stringList(source: unknown): string[] {
  return Array.isArray(source) ? source.filter((item): item is string => typeof item === "string") : [];
}

function declaredModalities(record: Record<string, unknown>): string[] {
  const direct = ["input", "input_modalities", "modalities"].flatMap((key) => stringList(record[key]));
  const architecture = record.architecture;
  const nested = isRecord(architecture) ? stringList(architecture.input_modalities) : [];
  return [...direct, ...nested];
}

function displayName(record: Record<string, unknown>): string | undefined {
  for (const key of ["display_name", "displayName", "name"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function rawId(record: Record<string, unknown>): string | undefined {
  const value = record.id ?? record.model ?? record.name;
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.startsWith("models/") ? value.slice("models/".length) : value;
}

/**
 * Field names real provider lists use for the context window and output cap,
 * including the OpenRouter-style nesting under `top_provider`.
 *
 * OpenAI's own spec defines only `id`/`object`/`created`/`owned_by`, so anything
 * richer is a gateway-specific extension and each one spells it differently:
 *
 * - `context_length`            OpenRouter and most marketplaces
 * - `context_window`            assorted gateways
 * - `max_model_len`             vLLM / SGLang model cards (the served limit)
 * - `inputTokenLimit`           Google Generative AI
 */
const CONTEXT_KEYS = [
  "contextWindow",
  "context_window",
  "context_length",
  "max_model_len",
  "inputTokenLimit",
  "input_token_limit",
  "max_context_length",
];
const OUTPUT_KEYS = [
  "maxTokens",
  "max_tokens",
  "outputTokenLimit",
  "output_token_limit",
  "max_output_tokens",
  "max_completion_tokens",
  "max_generation_tokens",
];

/** Tokens that unambiguously mark a capability in a model id. */
const REASONING_ID = /(?:^|[-_/])(?:reasoning|thinking|r1)(?:$|[-_/])/iu;
const IMAGE_ID = /(?:^|[-_/])(?:vision|image|multimodal)(?:$|[-_/])/iu;

export function parseModels(payload: unknown): DiscoveredModel[] {
  const root = isRecord(payload) ? payload : {};
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(root.data)
      ? root.data
      : Array.isArray(root.models)
        ? root.models
        : [];

  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = rawId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const model: DiscoveredModel = { id, sources: {} };

    // Some gateways echo the id as `name`; that is not a display name.
    const name = displayName(item);
    if (name && name !== id) {
      model.name = name.startsWith("models/") ? name.slice("models/".length) : name;
      model.sources.name = "upstream";
    }

    const context = positiveNumber(item, CONTEXT_KEYS);
    if (context !== undefined) {
      model.contextWindow = context;
      model.sources.contextWindow = "upstream";
    }
    const output = positiveNumber(item, OUTPUT_KEYS)
      ?? nestedPositiveNumber(item, "top_provider", ["max_completion_tokens", "max_tokens"]);
    if (output !== undefined) {
      model.maxTokens = output;
      model.sources.maxTokens = "upstream";
    }

    const declaredReasoning = item.reasoning === true
      || item.supports_reasoning === true
      || stringList(item.supported_parameters).includes("reasoning");
    const declaredImage = declaredModalities(item).some((entry) => /image|vision/iu.test(entry));
    if (declaredReasoning) {
      model.reasoning = true;
      model.sources.reasoning = "upstream";
    } else if (REASONING_ID.test(id)) {
      model.reasoning = true;
      model.sources.reasoning = "guess";
    }
    if (declaredImage) {
      model.image = true;
      model.sources.image = "upstream";
    } else if (IMAGE_ID.test(id)) {
      model.image = true;
      model.sources.image = "guess";
    }

    models.push(model);
  }
  return models.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Fills fields the upstream did not report from Pi's built-in catalog.
 *
 * Only missing values are taken. Overwriting would replace what a gateway
 * explicitly declared with the vendor's native maximum, and context window is
 * not cosmetic: it drives compaction thresholds and pricing tiers.
 */
export function applyCatalogMetadata(
  models: readonly DiscoveredModel[],
  catalog: ReadonlyMap<string, CatalogModel>,
): DiscoveredModel[] {
  return models.map((model) => {
    const known = catalog.get(model.id);
    if (!known) return model;
    const filled: DiscoveredModel = { ...model, sources: { ...model.sources } };

    if (filled.name === undefined && known.name) {
      filled.name = known.name;
      filled.sources.name = "catalog";
    }
    if (filled.contextWindow === undefined && known.contextWindow !== undefined) {
      filled.contextWindow = known.contextWindow;
      filled.sources.contextWindow = "catalog";
    }
    if (filled.maxTokens === undefined && known.maxTokens !== undefined) {
      filled.maxTokens = known.maxTokens;
      filled.sources.maxTokens = "catalog";
    }
    if (filled.reasoning === undefined && known.reasoning !== undefined) {
      filled.reasoning = known.reasoning;
      filled.sources.reasoning = "catalog";
    }
    if (filled.image === undefined && known.image !== undefined) {
      filled.image = known.image;
      filled.sources.image = "catalog";
    }
    return filled;
  });
}

export async function fetchModels(target: DiscoveryTarget, signal: AbortSignal): Promise<DiscoveredModel[]> {
  const url = modelsUrl(target.baseUrl, target.api);
  const response = await fetch(url, { headers: authHeaders(target), signal });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
    throw new Error(`${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`);
  }
  return parseModels(await response.json());
}

/** Splits a discovery result against what is already configured. */
export function partitionDiscovered(
  existing: readonly ModelEntry[],
  discovered: readonly DiscoveredModel[],
): { fresh: DiscoveredModel[]; known: DiscoveredModel[] } {
  const configured = new Set(existing.map((entry) => entry.id));
  return {
    fresh: discovered.filter((model) => !configured.has(model.id)),
    known: discovered.filter((model) => configured.has(model.id)),
  };
}

function sameInput(existing: ModelEntry, model: DiscoveredModel): boolean | undefined {
  if (!Array.isArray(existing.input)) return model.image === undefined ? undefined : model.image === false;
  return existing.input.includes("image") === (model.image === true);
}

/**
 * Classifies a discovered model against its configured entry.
 *
 * Only fields that would actually be written are compared, so a re-fetch does
 * not report a difference for metadata it never touches.
 */
export function compareWithExisting(existing: ModelEntry | undefined, model: DiscoveredModel): ExistingState {
  if (!existing) return "new";
  const differs =
    (model.name !== undefined && (existing.name ?? undefined) !== model.name)
    || (model.contextWindow !== undefined && existing.contextWindow !== model.contextWindow)
    || (model.maxTokens !== undefined && existing.maxTokens !== model.maxTokens)
    || (model.reasoning !== undefined && (existing.reasoning === true) !== model.reasoning)
    || sameInput(existing, model) === false;
  return differs ? "differs" : "same";
}

/**
 * Builds the stored entry. Absent fields are omitted rather than filled with
 * defaults, so a rewrite never invents a context window nobody reported.
 */
export function toModelEntry(model: DiscoveredModel): ModelEntry {
  const entry: ModelEntry = { id: model.id };
  if (model.name) entry.name = model.name;
  if (model.reasoning) entry.reasoning = true;
  if (model.image) entry.input = ["text", "image"];
  if (model.contextWindow !== undefined) entry.contextWindow = model.contextWindow;
  if (model.maxTokens !== undefined) entry.maxTokens = model.maxTokens;
  return entry;
}
