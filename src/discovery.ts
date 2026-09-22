import type { ModelEntry } from "./models-json.ts";

/**
 * Model discovery for a configured provider.
 *
 * Only fields the upstream actually reported are written back, so an entry
 * never carries a guessed number. Pi applies its own defaults for anything
 * absent, and the user can edit anything afterwards.
 */

export const SUPPORTED_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

export type ProviderApi = (typeof SUPPORTED_APIS)[number];

export interface DiscoveryTarget {
  baseUrl: string;
  api: ProviderApi;
  apiKey: string;
  headers?: Record<string, string>;
}

export interface DiscoveredModel {
  id: string;
  /** Upstream display name, when it differs from the id. */
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  image?: boolean;
  /** True when a capability came from the id pattern rather than the payload. */
  inferredReasoning?: boolean;
  inferredImage?: boolean;
}

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

    const modalities = declaredModalities(item);
    const declaredReasoning = item.reasoning === true || item.supports_reasoning === true
      || stringList(item.supported_parameters).includes("reasoning");
    const declaredImage = modalities.some((entry) => /image|vision/iu.test(entry));
    const model: DiscoveredModel = { id };

    const name = displayName(item);
    if (name && name !== id) model.name = name.startsWith("models/") ? name.slice("models/".length) : name;

    // OpenRouter-style catalogs put the window at the top level and the output
    // cap under `top_provider`.
    const context = positiveNumber(item, ["contextWindow", "context_window", "context_length", "inputTokenLimit", "input_token_limit"]);
    if (context !== undefined) model.contextWindow = context;
    const output = positiveNumber(item, ["maxTokens", "max_tokens", "outputTokenLimit", "output_token_limit"])
      ?? nestedPositiveNumber(item, "top_provider", ["max_completion_tokens", "max_tokens"]);
    if (output !== undefined) model.maxTokens = output;

    if (declaredReasoning) model.reasoning = true;
    else if (REASONING_ID.test(id)) {
      model.reasoning = true;
      model.inferredReasoning = true;
    }
    if (declaredImage) model.image = true;
    else if (IMAGE_ID.test(id)) {
      model.image = true;
      model.inferredImage = true;
    }

    models.push(model);
  }
  return models.sort((left, right) => left.id.localeCompare(right.id));
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

/**
 * Builds the stored entry. Absent fields are omitted rather than filled with
 * defaults, so a rewrite never invents a context window the upstream never
 * reported.
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
