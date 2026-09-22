import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Reader/writer for Pi's own model configuration.
 *
 * This file belongs to Pi, not to this extension, so edits are deliberately
 * conservative:
 *
 * - Unknown keys are preserved. Pi's schema allows them (other tools store
 *   ownership markers in it) and dropping them would silently break those.
 * - Pi's loader rejects the *entire* file when any entry fails schema
 *   validation, which would remove every model the user has. Callers must
 *   therefore validate after writing and roll back on failure.
 * - Pi accepts JSON with comments, so a rewrite would destroy them. The
 *   original is backed up and callers can warn before that happens.
 */

export interface ModelEntry {
  id: string;
  [key: string]: unknown;
}

export interface ProviderEntry {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models?: ModelEntry[];
  modelOverrides?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ModelsDocument {
  providers?: Record<string, ProviderEntry>;
  [key: string]: unknown;
}

export interface LoadedModels {
  doc: ModelsDocument;
  /** Verbatim file content, or undefined when the file did not exist. */
  raw: string | undefined;
  /** True when the file contains JSON comments that a rewrite would drop. */
  hadComments: boolean;
}

const BACKUP_SUFFIX = ".bak";

/** `getModelsPath()` is not exported to extensions; Pi's runtime uses the same join. */
export function modelsJsonPath(): string {
  return join(getAgentDir(), "models.json");
}

export function backupPath(): string {
  return `${modelsJsonPath()}${BACKUP_SUFFIX}`;
}

/**
 * Removes `//` and block comments the way Pi's loader does, while leaving
 * comment-like text inside strings alone.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        index++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index++;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      index++;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      index++;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Stripping only ever removes characters, so a length difference is a reliable
 * signal. Comparing against a trimmed copy would misreport a file whose only
 * difference is trailing whitespace.
 */
export function hasJsonComments(text: string): boolean {
  return stripJsonComments(text).length !== text.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asDocument(value: unknown): ModelsDocument {
  return isRecord(value) ? (value as ModelsDocument) : {};
}

export function readModels(): LoadedModels {
  const path = modelsJsonPath();
  if (!existsSync(path)) return { doc: {}, raw: undefined, hadComments: false };
  const raw = readFileSync(path, "utf8");
  const withoutBom = raw.replace(/^\uFEFF/u, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutBom);
  } catch {
    parsed = JSON.parse(stripJsonComments(withoutBom));
  }
  return { doc: asDocument(parsed), raw, hadComments: hasJsonComments(withoutBom) };
}

/**
 * Writes the document atomically, keeping a one-file backup of the previous
 * content so a bad edit is always recoverable by hand.
 *
 * `providers` is forced to exist: Pi requires the key, and a document without
 * it is rejected wholesale.
 */
export function writeModels(doc: ModelsDocument): void {
  const path = modelsJsonPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!isRecord(doc.providers)) doc.providers = {};
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    writeFileSync(backupPath(), current, { mode: 0o600 });
  }
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Restores a previous state, deleting the file when it did not exist before. */
export function restoreModels(raw: string | undefined): void {
  const path = modelsJsonPath();
  if (raw === undefined) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, raw, { mode: 0o600 });
  renameSync(temporary, path);
}

export function providerEntries(doc: ModelsDocument): Array<[string, ProviderEntry]> {
  const providers = doc.providers;
  if (!isRecord(providers)) return [];
  return Object.entries(providers as Record<string, ProviderEntry>).filter(([, entry]) => isRecord(entry));
}

export function getProvider(doc: ModelsDocument, id: string): ProviderEntry | undefined {
  return providerEntries(doc).find(([key]) => key === id)?.[1];
}

/** Providers are created without `models` so Pi keeps built-in models as-is. */
export function ensureProvider(doc: ModelsDocument, id: string): ProviderEntry {
  if (!isRecord(doc.providers)) doc.providers = {};
  const providers = doc.providers as Record<string, ProviderEntry>;
  const existing = providers[id];
  if (isRecord(existing)) return existing;
  const created: ProviderEntry = {};
  providers[id] = created;
  return created;
}

/**
 * Removes a provider's config.
 *
 * The `providers` key itself is always kept, even when it becomes empty: Pi's
 * schema declares it as required, and `{}` is rejected as
 * "Invalid models.json schema" — which would make deleting the last provider
 * impossible.
 */
export function removeProvider(doc: ModelsDocument, id: string): void {
  if (!isRecord(doc.providers)) {
    doc.providers = {};
    return;
  }
  delete (doc.providers as Record<string, ProviderEntry>)[id];
}

export function modelEntries(provider: ProviderEntry | undefined): ModelEntry[] {
  const models = provider?.models;
  if (!Array.isArray(models)) return [];
  return models.filter((entry): entry is ModelEntry => isRecord(entry) && typeof entry.id === "string");
}

export function findModel(provider: ProviderEntry | undefined, id: string): ModelEntry | undefined {
  return modelEntries(provider).find((entry) => entry.id === id);
}

/** Appends when absent, replaces in place when present, so order is stable. */
export function upsertModel(provider: ProviderEntry, entry: ModelEntry): void {
  const models = Array.isArray(provider.models) ? provider.models : [];
  const index = models.findIndex((candidate) => isRecord(candidate) && candidate.id === entry.id);
  if (index >= 0) models[index] = entry;
  else models.push(entry);
  provider.models = models;
}

export function removeModel(provider: ProviderEntry, id: string): void {
  if (!Array.isArray(provider.models)) return;
  provider.models = provider.models.filter((entry) => !(isRecord(entry) && entry.id === id));
  if (provider.models.length === 0) delete provider.models;
}
