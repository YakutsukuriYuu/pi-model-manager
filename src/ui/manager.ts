import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type Component, type Focusable, type TUI, Key, matchesKey } from "@earendil-works/pi-tui";
import {
  SUPPORTED_APIS,
  applyCatalogMetadata,
  compareWithExisting,
  type CatalogModel,
  type DiscoveredModel,
  type ExistingState,
  type FieldSource,
  type ProviderApi,
} from "../discovery.ts";
import {
  type LoadedModels,
  type ModelEntry,
  type ModelOverrideEntry,
  type ModelsDocument,
  type ProviderEntry,
  ensureModelOverrides,
  ensureProvider,
  findModel,
  findModelOverride,
  modelEntries,
  modelOverridesOf,
  modelsJsonPath,
  pruneEmptyProvider,
  providerEntries,
  removeModel,
  removeModelOverride,
  removeProvider,
  upsertModel,
} from "../models-json.ts";
import {
  SELECTED_MARKER,
  UNSELECTED_MARKER,
  type Column,
  type KeyHint,
  type ThemeLike,
  compactCount,
  frame,
  hintLines,
  safeTheme,
  table,
} from "./frame.ts";

/** Re-exported so the extension entry point can build the catalog index. */
export type { CatalogModel };

/** Where a row's effective values come from. */
export type ModelOrigin = "config" | "override" | "builtin";

export interface ModelRow extends CatalogModel {
  /** Present in the provider's `models` list. */
  inConfig: boolean;
  /** Has a `modelOverrides` entry, which Pi merges over the catalog model. */
  hasOverride: boolean;
  current: boolean;
  /** Effective source of the displayed values. */
  origin: ModelOrigin;
}

/** A model Pi ships is edited through `modelOverrides`, not a new entry. */
type ModelTarget = "model" | "override";

const ORIGIN_LABEL: Record<ModelOrigin, string> = { config: "配置", override: "覆盖", builtin: "内置" };

/** Where a provider's credential comes from, without exposing the credential. */
export interface ProviderAuth {
  configured: boolean;
  label: string;
}

export interface ProviderRow {
  id: string;
  name?: string;
  api?: string;
  modelCount: number;
  inConfig: boolean;
  auth: ProviderAuth;
}

const NO_AUTH: ProviderAuth = { configured: false, label: "未登录" };

/**
 * Short label for a credential's origin.
 *
 * A provider reached through `/login` is as much the user's as one defined in
 * models.json, so the list has to tell the two apart instead of hiding one.
 */
export function authLabel(source: string | undefined): string {
  switch (source) {
    case "stored":
      return "已登录";
    case "runtime":
      return "本次运行";
    case "environment":
      return "环境变量";
    case "fallback":
      return "扩展";
    case "models_json_key":
    case "models_json_command":
      return "配置";
    default:
      return "未登录";
  }
}

export interface ProviderDraft {
  id: string;
  name?: string;
  baseUrl: string;
  api: ProviderApi;
  apiKey?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
}

export interface ModelDraft {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  image?: boolean;
}

export interface SaveResult {
  ok: boolean;
  error?: string;
}

export interface ManagerHost {
  /** Re-read models.json from disk. */
  load(): LoadedModels;
  /** Persist and verify through Pi, rolling back when Pi rejects the file. */
  save(doc: ModelsDocument): Promise<SaveResult>;
  /** Every provider id Pi knows about, built-ins included. */
  catalogProviderIds(): string[];
  catalogModels(providerId: string): CatalogModel[];
  /**
   * Pi's catalog keyed by model id, used to fill fields an upstream omits.
   * Providers already defined in models.json are excluded so the user's own
   * (possibly stale) values can never be fed back as if they were a reference.
   */
  catalogMetadata(): Map<string, CatalogModel>;
  /** Configured values used to prefill a provider that has no config yet. */
  providerDefaults(providerId: string): { name?: string; baseUrl?: string; api?: string };
  /**
   * Where a provider's credential comes from, if anywhere.
   *
   * Read from Pi rather than from models.json, so providers authenticated with
   * `/login` are visible without ever reading the credential itself.
   */
  authStatus(providerId: string): { configured: boolean; source?: string };
  fetchModels(providerId: string, baseUrl: string, api: ProviderApi): Promise<DiscoveredModel[]>;
  currentModelId(providerId: string): string | undefined;
  setModel(providerId: string, modelId: string): Promise<boolean>;
  notify(message: string, tone: "info" | "warning" | "error"): void;
  close(): void;
}

interface FormField {
  label: string;
  value: string;
  edit?(): void;
  cycle?(delta: number): void;
}

interface Editing {
  label: string;
  buffer: string;
  secret: boolean;
  /**
   * True while the buffer still holds an untouched previous value. The first
   * typed character replaces it, because appending to a prefilled field is how
   * a value like `1000` silently becomes `1000200000`.
   */
  fresh: boolean;
  commit(value: string): void;
}

/**
 * A destructive action waiting for explicit confirmation.
 *
 * Deletion is irreversible from the UI (the file backup is the only recovery),
 * so it must not happen on a single keystroke.
 */
interface PendingConfirm {
  prompt: string;
  run(): void;
}

/** One discovery result plus how it relates to the configured entry. */
interface FetchRow {
  model: DiscoveredModel;
  state: ExistingState;
}

type Screen =
  | { kind: "providers"; index: number }
  | { kind: "models"; providerId: string; index: number }
  | { kind: "providerForm"; providerId: string; isNew: boolean; draft: ProviderDraft; field: number }
  | { kind: "modelForm"; providerId: string; originalId: string; isNew: boolean; target: ModelTarget; draft: ModelDraft; field: number }
  | { kind: "fetch"; providerId: string; rows: FetchRow[]; checked: Set<string>; index: number };

/** How long a transient message stays before it clears itself. */
const NOTICE_TTL_MS = 4_000;

const PROVIDER_ACTIONS: KeyHint[] = [
  { keys: "↑↓/PgUp/PgDn/Home/End", label: "选择" },
  { keys: "Enter", label: "进入" },
  { keys: "n", label: "新建" },
  { keys: "b", label: "内置" },
  { keys: "r", label: "重载" },
  { keys: "d", label: "删除" },
  { keys: "Esc", label: "关闭" },
];

const MODEL_ACTIONS: KeyHint[] = [
  { keys: "↑↓/PgUp/PgDn/Home/End", label: "选择" },
  { keys: "Enter", label: "使用" },
  { keys: "e", label: "编辑模型" },
  { keys: "a", label: "添加模型" },
  { keys: "f", label: "获取模型" },
  { keys: "p", label: "编辑接入" },
  { keys: "d", label: "删除" },
  { keys: "Esc", label: "返回" },
];

const FORM_ACTIONS: KeyHint[] = [
  { keys: "↑↓", label: "选择字段" },
  { keys: "Enter", label: "编辑" },
  { keys: "←→", label: "切换" },
  { keys: "Ctrl+S", label: "保存" },
  { keys: "Esc", label: "取消" },
];

const FETCH_ACTIONS: KeyHint[] = [
  { keys: "↑↓/PgUp/PgDn/Home/End", label: "移动" },
  { keys: "Space", label: "勾选" },
  { keys: "u", label: "勾选值不同的" },
  { keys: "a", label: "全选/全不选" },
  { keys: "Enter", label: "保存" },
  { keys: "Esc", label: "取消" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- pure helpers (covered by tests) --------------------------------------------

export function buildProviderRows(
  configProviders: Array<[string, ProviderEntry]>,
  catalogIds: readonly string[],
  catalogCounts: ReadonlyMap<string, number>,
  authById: ReadonlyMap<string, ProviderAuth> = new Map(),
): ProviderRow[] {
  const rows: ProviderRow[] = configProviders.map(([id, entry]) => ({
    id,
    name: typeof entry.name === "string" ? entry.name : undefined,
    api: typeof entry.api === "string" ? entry.api : undefined,
    modelCount: modelEntries(entry).length || (catalogCounts.get(id) ?? 0),
    inConfig: true,
    auth: authById.get(id) ?? NO_AUTH,
  }));
  const configured = new Set(rows.map((row) => row.id));
  for (const id of catalogIds) {
    if (configured.has(id)) continue;
    rows.push({ id, modelCount: catalogCounts.get(id) ?? 0, inConfig: false, auth: authById.get(id) ?? NO_AUTH });
  }
  return rows.sort((left, right) => {
    if (left.inConfig !== right.inConfig) return left.inConfig ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
}

function pickString(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" ? value : undefined;
}

function pickNumber(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === "number" ? value : undefined;
}

function pickBoolean(source: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = source?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function pickImage(source: Record<string, unknown> | undefined): boolean | undefined {
  const input = source?.input;
  return Array.isArray(input) ? input.includes("image") : undefined;
}

type DisplayValues = Pick<ModelRow, "name" | "contextWindow" | "maxTokens" | "reasoning" | "image">;

/**
 * Overlays a `modelOverrides` entry the way Pi does: field by field, with the
 * override winning. Pi applies overrides last, so the displayed values have to
 * be merged in the same order or the list would disagree with the runtime.
 */
function applyOverride(base: DisplayValues, override: ModelOverrideEntry | undefined): DisplayValues {
  if (!override) return base;
  return {
    name: pickString(override, "name") ?? base.name,
    contextWindow: pickNumber(override, "contextWindow") ?? base.contextWindow,
    maxTokens: pickNumber(override, "maxTokens") ?? base.maxTokens,
    reasoning: pickBoolean(override, "reasoning") ?? base.reasoning,
    image: pickImage(override) ?? base.image,
  };
}

export function buildModelRows(
  configModels: readonly ModelEntry[],
  catalog: readonly CatalogModel[],
  currentId: string | undefined,
  overrides: Record<string, ModelOverrideEntry> = {},
): ModelRow[] {
  const known = new Map(catalog.map((model) => [model.id, model]));
  const rows: ModelRow[] = configModels.map((entry) => {
    const fallback = known.get(entry.id);
    const override = overrides[entry.id];
    const values = applyOverride(
      {
        name: pickString(entry, "name") ?? fallback?.name,
        contextWindow: pickNumber(entry, "contextWindow") ?? fallback?.contextWindow,
        maxTokens: pickNumber(entry, "maxTokens") ?? fallback?.maxTokens,
        reasoning: pickBoolean(entry, "reasoning") ?? fallback?.reasoning,
        image: pickImage(entry) ?? fallback?.image,
      },
      override,
    );
    return {
      id: entry.id,
      ...values,
      inConfig: true,
      hasOverride: override !== undefined,
      current: entry.id === currentId,
      origin: override ? "override" : "config",
    };
  });
  const configured = new Set(rows.map((row) => row.id));
  for (const model of catalog) {
    if (configured.has(model.id)) continue;
    const override = overrides[model.id];
    rows.push({
      id: model.id,
      ...applyOverride(model, override),
      inConfig: false,
      hasOverride: override !== undefined,
      current: model.id === currentId,
      origin: override ? "override" : "builtin",
    });
  }
  return rows;
}

export function validateProviderDraft(draft: ProviderDraft): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(draft.id)) return "接入 ID 只能包含字母、数字和 . _ -，且不能以符号开头";
  const baseUrl = draft.baseUrl.trim();
  if (baseUrl.length === 0) return "Base URL 不能为空";
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Base URL 必须以 http:// 或 https:// 开头";
  } catch {
    return "Base URL 不是合法地址";
  }
  return undefined;
}

export function validateModelDraft(draft: ModelDraft): string | undefined {
  if (draft.id.trim().length === 0) return "模型 ID 不能为空";
  for (const value of [draft.contextWindow, draft.maxTokens]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) return "上下文窗口和最大输出必须是正整数";
  }
  return undefined;
}

function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === "") delete target[key];
  else target[key] = value;
}

/** Touches only the fields the form exposes, so other keys survive untouched. */
export function applyProviderDraft(existing: ProviderEntry, draft: ProviderDraft): void {
  setOrDelete(existing, "name", draft.name?.trim() || undefined);
  setOrDelete(existing, "baseUrl", draft.baseUrl.trim() || undefined);
  setOrDelete(existing, "api", draft.api);
  setOrDelete(existing, "apiKey", draft.apiKey?.trim() || undefined);
  setOrDelete(existing, "authHeader", draft.authHeader === true ? true : undefined);
  setOrDelete(existing, "headers", draft.headers && Object.keys(draft.headers).length > 0 ? draft.headers : undefined);
}

export function applyModelDraft(existing: Record<string, unknown>, draft: ModelDraft): void {
  setOrDelete(existing, "name", draft.name?.trim() || undefined);
  setOrDelete(existing, "reasoning", draft.reasoning === true ? true : undefined);
  // Pi defaults to text-only, so "text" alone is expressed by removing the key.
  setOrDelete(existing, "input", draft.image === true ? ["text", "image"] : undefined);
  setOrDelete(existing, "contextWindow", draft.contextWindow);
  setOrDelete(existing, "maxTokens", draft.maxTokens);
}

export function draftFromProvider(
  id: string,
  entry: ProviderEntry | undefined,
  defaults: { name?: string; baseUrl?: string; api?: string },
): ProviderDraft {
  const api = typeof entry?.api === "string" ? entry.api : defaults.api;
  return {
    id,
    name: typeof entry?.name === "string" ? entry.name : defaults.name,
    baseUrl: typeof entry?.baseUrl === "string" ? entry.baseUrl : defaults.baseUrl ?? "",
    api: (SUPPORTED_APIS as readonly string[]).includes(api ?? "") ? (api as ProviderApi) : "openai-completions",
    apiKey: typeof entry?.apiKey === "string" ? entry.apiKey : undefined,
    authHeader: entry?.authHeader === true,
    headers: isRecord(entry?.headers) ? (entry.headers as Record<string, string>) : undefined,
  };
}

/**
 * Builds a draft from either a `models` entry or a `modelOverrides` entry.
 *
 * An override body carries no id (the key is the id), so `explicitId` supplies
 * it for the form, and a catalog model supplies values for untouched fields.
 */
export function draftFromModel(
  entry: Record<string, unknown> | undefined,
  fallback: CatalogModel | undefined,
  explicitId?: string,
): ModelDraft {
  return {
    id: explicitId ?? pickString(entry, "id") ?? fallback?.id ?? "",
    name: pickString(entry, "name"),
    contextWindow: pickNumber(entry, "contextWindow") ?? fallback?.contextWindow,
    maxTokens: pickNumber(entry, "maxTokens") ?? fallback?.maxTokens,
    reasoning: pickBoolean(entry, "reasoning") ?? fallback?.reasoning,
    image: pickImage(entry) ?? fallback?.image,
  };
}

export function parseHeaders(text: string): Record<string, string> | undefined | Error {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return new Error('请求头必须是 JSON 对象，例如 {"X-Token":"abc"}');
  }
  if (!isRecord(parsed)) return new Error("请求头必须是 JSON 对象");
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") return new Error(`请求头 ${key} 的值必须是字符串`);
    headers[key] = value;
  }
  return headers;
}

/** API keys may be literals, `$ENV` references, or `!command` values. */
export function redactSecret(value: string): string {
  if (value.startsWith("$") || value.startsWith("!")) return value;
  if (value.length <= 8) return "•".repeat(Math.max(1, value.length));
  return `${value.slice(0, 4)}…${value.slice(-3)}`;
}

const STATUS_LABEL: Record<ExistingState, string> = { new: "新增", differs: "不同", same: "已存在" };

const SOURCE_MARK: Record<FieldSource, string> = { upstream: "", catalog: "*", guess: "?" };

/**
 * Appends the provenance marker to a displayed value, so where a number came
 * from is visible right where it is read rather than only in a legend.
 */
export function markValue(value: string, source: FieldSource | undefined): string {
  return source === undefined ? value : `${value}${SOURCE_MARK[source]}`;
}

export function describeCapabilities(
  model: { reasoning?: boolean; image?: boolean },
  sources?: DiscoveredModel["sources"],
): string {
  const parts: string[] = [];
  if (model.reasoning) parts.push(markValue("思考", sources?.reasoning));
  if (model.image) parts.push(markValue("图片", sources?.image));
  return parts.join(" ") || "文本";
}

// --- component ------------------------------------------------------------------

export class ModelManager implements Component, Focusable {
  private screen: Screen = { kind: "providers", index: 0 };
  /** Reveals Pi's own providers, which have no config to manage by default. */
  private showBuiltins = false;
  private loaded: LoadedModels;
  private readonly tui: TUI;
  private readonly theme: ThemeLike;
  private editing: Editing | null = null;
  private pendingConfirm: PendingConfirm | null = null;
  private status: { text: string; tone: "dim" | "warning" | "error" } | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private _focused = false;

  private readonly host: ManagerHost;

  constructor(tui: TUI, theme: Theme, loaded: LoadedModels, host: ManagerHost) {
    this.tui = tui;
    this.theme = safeTheme(theme);
    this.loaded = loaded;
    this.host = host;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.invalidate();
  }

  // --- state helpers ------------------------------------------------------------

  private refresh(message?: string, tone: "dim" | "warning" | "error" = "dim"): void {
    if (message !== undefined) this.setStatus(message, tone);
    this.invalidate();
    this.tui.requestRender();
  }

  private providerRows(): ProviderRow[] {
    const configured = providerEntries(this.loaded.doc);
    const counts = new Map<string, number>();
    for (const [id, entry] of configured) counts.set(id, modelEntries(entry).length);

    // A provider reached through `/login` is as much the user's as one with a
    // models.json entry, so the credential status decides what is worth
    // listing rather than the file alone.
    const auth = new Map<string, ProviderAuth>();
    const ids = new Set<string>([...configured.map(([id]) => id), ...this.host.catalogProviderIds()]);
    for (const id of ids) {
      const status = this.host.authStatus(id);
      auth.set(id, { configured: status.configured, label: authLabel(status.source) });
    }

    const rows = buildProviderRows(configured, this.host.catalogProviderIds(), counts, auth);
    // Providers with neither config nor a credential hold none of the user's
    // setup, and a list of them buries the ones that do.
    const visible = this.showBuiltins ? rows : rows.filter((row) => row.inConfig || row.auth.configured);

    // Anything without a config takes its count from Pi's catalog. Reading 0
    // would report the opposite of the truth — a provider reached through
    // `/login` does have models.
    for (const row of visible) {
      if (row.inConfig) continue;
      row.modelCount = this.host.catalogModels(row.id).length;
    }
    return visible;
  }

  private providerEntry(id: string): ProviderEntry | undefined {
    return providerEntries(this.loaded.doc).find(([key]) => key === id)?.[1];
  }

  private modelRows(providerId: string): ModelRow[] {
    const provider = this.providerEntry(providerId);
    return buildModelRows(
      modelEntries(provider),
      this.host.catalogModels(providerId),
      this.host.currentModelId(providerId),
      modelOverridesOf(provider),
    );
  }

  private providerDefaults(providerId: string): { name?: string; baseUrl?: string; api?: string } {
    return this.host.providerDefaults(providerId);
  }

  /**
   * Rows a list may occupy.
   *
   * This component replaces the editor rather than owning the screen, so the
   * transcript keeps the space above it. Half the terminal keeps the frame
   * inside the layout at every size, and the cap stops a very tall terminal
   * from turning the list into something the eye cannot scan.
   */
  private maxListRows(): number {
    const rows = this.tui.terminal?.rows ?? 40;
    return Math.max(4, Math.min(18, Math.floor(rows / 2) - 3));
  }

  private async commit(doc: ModelsDocument, success: string): Promise<boolean> {
    this.busy = true;
    this.refresh("保存中…");
    const result = await this.host.save(doc);
    this.busy = false;
    if (!result.ok) {
      this.refresh(`保存失败，已回滚：${result.error ?? "未知错误"}`, "error");
      return false;
    }
    this.loaded = this.host.load();
    this.refresh(success);
    return true;
  }

  private async saveProviderDraft(screen: Extract<Screen, { kind: "providerForm" }>): Promise<void> {
    const problem = validateProviderDraft(screen.draft);
    if (problem) {
      this.refresh(problem, "warning");
      return;
    }
    const doc = structuredClone(this.loaded.doc);
    if (screen.isNew && this.providerEntry(screen.draft.id)) {
      this.refresh(`接入 ${screen.draft.id} 已存在`, "warning");
      return;
    }
    if (!screen.isNew && screen.providerId !== screen.draft.id) removeProvider(doc, screen.providerId);
    applyProviderDraft(ensureProvider(doc, screen.draft.id), screen.draft);
    if (await this.commit(doc, `已保存接入 ${screen.draft.id}`)) {
      this.screen = { kind: "models", providerId: screen.draft.id, index: 0 };
    }
  }

  private async saveModelDraft(screen: Extract<Screen, { kind: "modelForm" }>): Promise<void> {
    const problem = validateModelDraft(screen.draft);
    if (problem) {
      this.refresh(problem, "warning");
      return;
    }
    const doc = structuredClone(this.loaded.doc);
    const provider = ensureProvider(doc, screen.providerId);

    if (screen.target === "override") {
      // Pi keeps catalog models in generated metadata, so a change to one is
      // stored as an override that Pi merges over the catalog entry.
      const overrides = ensureModelOverrides(provider);
      const body: Record<string, unknown> = { ...overrides[screen.draft.id] };
      applyModelDraft(body, screen.draft);
      delete body.id;
      if (!screen.isNew && screen.originalId !== screen.draft.id) delete overrides[screen.originalId];
      const cleared = Object.keys(body).length === 0;
      if (cleared) delete overrides[screen.draft.id];
      else overrides[screen.draft.id] = body;
      if (Object.keys(overrides).length === 0) delete provider.modelOverrides;
      // A provider entry that configures nothing is rejected by Pi, so the
      // entry has to disappear once its last override is cleared.
      pruneEmptyProvider(doc, screen.providerId);
      if (await this.commit(doc, cleared ? `已清空 ${screen.draft.id} 的覆盖配置` : `已保存 ${screen.draft.id} 的覆盖配置`)) {
        this.screen = { kind: "models", providerId: screen.providerId, index: 0 };
      }
      return;
    }

    const existing = findModel(provider, screen.draft.id) ?? { id: screen.draft.id };
    applyModelDraft(existing, screen.draft);
    if (!screen.isNew && screen.originalId !== screen.draft.id) removeModel(provider, screen.originalId);
    upsertModel(provider, existing);
    if (await this.commit(doc, `已保存模型 ${screen.draft.id}`)) {
      this.screen = { kind: "models", providerId: screen.providerId, index: 0 };
    }
  }

  private async saveFetched(screen: Extract<Screen, { kind: "fetch" }>): Promise<void> {
    const chosen = screen.rows.filter((row) => screen.checked.has(row.model.id));
    if (chosen.length === 0) {
      this.refresh("没有勾选任何模型", "warning");
      return;
    }
    const doc = structuredClone(this.loaded.doc);
    const provider = ensureProvider(doc, screen.providerId);
    for (const row of chosen) upsertModel(provider, toEntry(row.model));
    const updated = chosen.filter((row) => row.state === "differs").length;
    const added = chosen.length - updated;
    if (await this.commit(doc, `已新增 ${added} 个模型${updated > 0 ? `，更新 ${updated} 个` : ""}`)) {
      this.screen = { kind: "models", providerId: screen.providerId, index: 0 };
    }
  }

  private async runFetch(providerId: string, baseUrl: string, api: ProviderApi): Promise<void> {
    this.busy = true;
    this.refresh("正在从上游获取模型…");
    try {
      // Pi's catalog only fills what the upstream left blank.
      const discovered = applyCatalogMetadata(await this.host.fetchModels(providerId, baseUrl, api), this.host.catalogMetadata());
      const rows: FetchRow[] = discovered.map((model) => ({
        model,
        state: compareWithExisting(findModel(this.providerEntry(providerId), model.id), model),
      }));
      // Only genuinely new models start selected; updating an existing entry
      // changes context window and therefore cost, so it stays opt-in.
      const checked = new Set(rows.filter((row) => row.state === "new").map((row) => row.model.id));
      this.screen = { kind: "fetch", providerId, rows, checked, index: 0 };
      const differs = rows.filter((row) => row.state === "differs").length;
      this.refresh(
        rows.length === 0
          ? "上游没有返回模型"
          : `发现 ${rows.length} 个 · 新增 ${checked.size} 个（已勾选）${differs > 0 ? ` · ${differs} 个值不同（按 u 勾选更新）` : ""}`,
        rows.length === 0 ? "warning" : "dim",
      );
    } catch (error) {
      this.refresh(`获取失败：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      this.busy = false;
    }
  }

  private async useModel(providerId: string, modelId: string): Promise<void> {
    const ok = await this.host.setModel(providerId, modelId);
    this.refresh(
      ok ? `当前模型已切换到 ${providerId}/${modelId}` : `无法使用 ${providerId}/${modelId}：接入未配置认证`,
      ok ? "dim" : "error",
    );
  }

  // --- input --------------------------------------------------------------------

  handleInput(data: string): void {
    if (this.busy) return;
    if (this.editing) {
      this.handleEditingInput(data);
      return;
    }
    if (this.pendingConfirm) {
      this.handleConfirmInput(data);
      return;
    }
    switch (this.screen.kind) {
      case "providers":
        this.handleProviders(data);
        return;
      case "models":
        this.handleModels(data);
        return;
      case "providerForm":
        this.handleProviderForm(data);
        return;
      case "modelForm":
        this.handleModelForm(data);
        return;
      case "fetch":
        this.handleFetch(data);
        return;
    }
  }

  /** Asks before a destructive write; the next non-`y` key cancels. */
  private confirmDelete(prompt: string, run: () => void): void {
    this.pendingConfirm = { prompt, run };
    this.refresh();
  }

  private handleConfirmInput(data: string): void {
    const pending = this.pendingConfirm;
    if (!pending) return;
    this.pendingConfirm = null;
    if (data === "y" || data === "Y") {
      pending.run();
      return;
    }
    this.refresh("已取消");
  }

  private handleEditingInput(data: string): void {
    const editing = this.editing;
    if (!editing) return;
    if (matchesKey(data, Key.escape)) {
      this.editing = null;
      this.refresh("已取消编辑");
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.editing = null;
      editing.commit(editing.buffer);
      return;
    }
    if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
      this.editing = { ...editing, buffer: editing.buffer.slice(0, -1), fresh: false };
      this.refresh();
      return;
    }
    if (data.length > 0 && !data.includes("\x1b") && [...data].every((char) => char >= " ")) {
      this.editing = { ...editing, buffer: (editing.fresh ? "" : editing.buffer) + data, fresh: false };
      this.refresh();
    }
  }

  private move(index: number, delta: number, count: number): number {
    if (count === 0) return 0;
    return (index + delta + count) % count;
  }

  /**
   * Shared list navigation.
   *
   * Returns the new index, or undefined when the key is not a navigation key.
   * Up/down wrap, while paging and Home/End stop at the ends, which is what
   * those keys are expected to do.
   */
  private navigate(data: string, index: number, count: number, page: number): number | undefined {
    if (matchesKey(data, Key.up)) return this.move(index, -1, count);
    if (matchesKey(data, Key.down)) return this.move(index, 1, count);
    if (count === 0) return undefined;
    if (matchesKey(data, Key.pageUp)) return Math.max(0, index - page);
    if (matchesKey(data, Key.pageDown)) return Math.min(count - 1, index + page);
    if (matchesKey(data, Key.home)) return 0;
    if (matchesKey(data, Key.end)) return count - 1;
    return undefined;
  }

  private handleProviders(data: string): void {
    const screen = this.screen as Extract<Screen, { kind: "providers" }>;
    const rows = this.providerRows();
    if (matchesKey(data, Key.escape) || data === "q") {
      this.host.close();
      return;
    }
    const next = this.navigate(data, screen.index, rows.length, this.maxListRows());
    if (next !== undefined) {
      this.screen = { ...screen, index: next };
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const row = rows[screen.index];
      if (row) this.screen = { kind: "models", providerId: row.id, index: 0 };
      this.refresh();
      return;
    }
    if (data === "n") {
      this.screen = { kind: "providerForm", providerId: "", isNew: true, draft: draftFromProvider("", undefined, {}), field: 0 };
      this.refresh();
      return;
    }
    if (data === "b") {
      this.showBuiltins = !this.showBuiltins;
      this.screen = { ...screen, index: 0 };
      this.refresh(
        this.showBuiltins
          ? "已显示 Pi 内置接入：进入后按 e 可给内置模型写覆盖"
          : "已隐藏未配置的内置接入",
      );
      return;
    }
    if (data === "r") {
      this.loaded = this.host.load();
      this.refresh("已从磁盘重载 models.json");
      return;
    }
    if (data === "d") {
      const row = rows[screen.index];
      if (!row) return;
      if (!row.inConfig) {
        this.refresh(`${row.id} 是 Pi 内置接入，没有可删除的配置`, "warning");
        return;
      }
      const models = rows.find((candidate) => candidate.id === row.id)?.modelCount ?? 0;
      this.confirmDelete(`删除接入 ${row.id} 的配置（含 ${models} 个模型）？`, () => {
        const doc = structuredClone(this.loaded.doc);
        removeProvider(doc, row.id);
        void this.commit(doc, `已删除接入 ${row.id} 的配置`);
      });
    }
  }

  private handleModels(data: string): void {
    const screen = this.screen as Extract<Screen, { kind: "models" }>;
    const rows = this.modelRows(screen.providerId);
    if (matchesKey(data, Key.escape)) {
      this.screen = { kind: "providers", index: 0 };
      this.refresh();
      return;
    }
    const next = this.navigate(data, screen.index, rows.length, this.maxListRows());
    if (next !== undefined) {
      this.screen = { ...screen, index: next };
      this.refresh();
      return;
    }
    const row = rows[screen.index];
    if (matchesKey(data, Key.enter)) {
      if (row) void this.useModel(screen.providerId, row.id);
      return;
    }
    if (data === "e") {
      if (!row) return;
      this.screen = {
        kind: "modelForm",
        providerId: screen.providerId,
        originalId: row.id,
        isNew: false,
        // A model Pi ships has no `models` entry to edit, so the change is
        // written as an override instead.
        target: row.inConfig ? "model" : "override",
        draft: draftFromModel(
          row.inConfig ? findModel(this.providerEntry(screen.providerId), row.id) : findModelOverride(this.providerEntry(screen.providerId), row.id),
          // An override form starts from the override alone. Prefilling it from
          // the catalog would write those values back as overrides just because
          // the form was opened and saved, pinning the model to today's numbers.
          row.inConfig ? row : undefined,
          row.id,
        ),
        field: 0,
      };
      this.refresh();
      return;
    }
    if (data === "p") {
      const entry = this.providerEntry(screen.providerId);
      this.screen = {
        kind: "providerForm",
        providerId: screen.providerId,
        isNew: false,
        draft: draftFromProvider(screen.providerId, entry, this.providerDefaults(screen.providerId)),
        field: 0,
      };
      this.refresh();
      return;
    }
    if (data === "a") {
      this.screen = {
        kind: "modelForm",
        providerId: screen.providerId,
        originalId: "",
        isNew: true,
        target: "model",
        draft: draftFromModel(undefined, undefined),
        field: 0,
      };
      this.refresh();
      return;
    }
    if (data === "f") {
      const entry = this.providerEntry(screen.providerId);
      const defaults = this.providerDefaults(screen.providerId);
      const baseUrl = (typeof entry?.baseUrl === "string" && entry.baseUrl) || defaults.baseUrl || "";
      const api = (typeof entry?.api === "string" && entry.api) || defaults.api || "openai-completions";
      if (!baseUrl) {
        this.refresh("该接入还没有 Base URL，先按 p 编辑接入", "warning");
        return;
      }
      const known = (SUPPORTED_APIS as readonly string[]).includes(api) ? (api as ProviderApi) : "openai-completions";
      void this.runFetch(screen.providerId, baseUrl, known);
      return;
    }
    if (data === "d") {
      if (!row) return;
      if (row.inConfig) {
        this.confirmDelete(`删除模型 ${row.id} 的配置？`, () => {
          const doc = structuredClone(this.loaded.doc);
          const provider = ensureProvider(doc, screen.providerId);
          removeModel(provider, row.id);
          // An override left behind by the deleted model would be dead config.
          removeModelOverride(provider, row.id);
          pruneEmptyProvider(doc, screen.providerId);
          void this.commit(doc, `已删除模型 ${row.id}`);
        });
        return;
      }
      if (row.hasOverride) {
        this.confirmDelete(`删除 ${row.id} 的覆盖配置？`, () => {
          const doc = structuredClone(this.loaded.doc);
          removeModelOverride(ensureProvider(doc, screen.providerId), row.id);
          pruneEmptyProvider(doc, screen.providerId);
          void this.commit(doc, `已删除 ${row.id} 的覆盖配置`);
        });
        return;
      }
      this.refresh(`${row.id} 来自 Pi 内置目录，没有可删除的配置（按 e 可以给它写一条覆盖）`, "warning");
    }
  }

  /**
   * Shared key handling for both forms. The narrowed screen is passed in as a
   * local so the union stays narrowed inside the callbacks.
   */
  private handleFormKeys(
    data: string,
    field: number,
    fields: FormField[],
    actions: {
      setField(field: number): void;
      back(): void;
      save(): void;
    },
  ): void {
    if (matchesKey(data, Key.escape)) {
      actions.back();
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.ctrl("s"))) {
      actions.save();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      actions.setField(this.move(field, matchesKey(data, Key.up) ? -1 : 1, fields.length));
      this.refresh();
      return;
    }
    const current = fields[field];
    if (!current) return;
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      current.cycle?.(matchesKey(data, Key.left) ? -1 : 1);
      return;
    }
    if (matchesKey(data, Key.enter)) current.edit?.();
  }

  private handleProviderForm(data: string): void {
    if (this.screen.kind !== "providerForm") return;
    const screen = this.screen;
    this.handleFormKeys(data, screen.field, this.providerFields(screen), {
      setField: (field) => {
        this.screen = { ...screen, field };
      },
      back: () => {
        this.screen = screen.isNew ? { kind: "providers", index: 0 } : { kind: "models", providerId: screen.providerId, index: 0 };
      },
      save: () => void this.saveProviderDraft(screen),
    });
  }

  private handleModelForm(data: string): void {
    if (this.screen.kind !== "modelForm") return;
    const screen = this.screen;
    this.handleFormKeys(data, screen.field, this.modelFields(screen), {
      setField: (field) => {
        this.screen = { ...screen, field };
      },
      back: () => {
        this.screen = { kind: "models", providerId: screen.providerId, index: 0 };
      },
      save: () => void this.saveModelDraft(screen),
    });
  }

  private handleFetch(data: string): void {
    const screen = this.screen as Extract<Screen, { kind: "fetch" }>;
    if (matchesKey(data, Key.escape)) {
      this.screen = { kind: "models", providerId: screen.providerId, index: 0 };
      this.refresh();
      return;
    }
    const next = this.navigate(data, screen.index, screen.rows.length, this.maxListRows());
    if (next !== undefined) {
      this.screen = { ...screen, index: next };
      this.refresh();
      return;
    }
    const row = screen.rows[screen.index];
    if (matchesKey(data, Key.space)) {
      if (!row) return;
      const checked = new Set(screen.checked);
      if (checked.has(row.model.id)) checked.delete(row.model.id);
      else checked.add(row.model.id);
      this.screen = { ...screen, checked };
      this.refresh();
      return;
    }
    if (data === "a") {
      const allChecked = screen.checked.size === screen.rows.length && screen.rows.length > 0;
      this.screen = { ...screen, checked: allChecked ? new Set() : new Set(screen.rows.map((entry) => entry.model.id)) };
      this.refresh();
      return;
    }
    if (data === "u") {
      // Opt in to rewriting entries whose values differ from upstream. This is
      // separate from "a" because it changes context windows and thus cost.
      const changed = screen.rows.filter((entry) => entry.state !== "same").map((entry) => entry.model.id);
      if (changed.length === 0) {
        this.refresh("没有值不同的模型", "warning");
        return;
      }
      this.screen = { ...screen, checked: new Set(changed) };
      this.refresh(`已勾选 ${changed.length} 个新增或值不同的模型`);
      return;
    }
    if (matchesKey(data, Key.enter)) void this.saveFetched(screen);
  }

  // --- field definitions --------------------------------------------------------

  private textField(label: string, current: string, secret: boolean, commit: (value: string) => void): void {
    this.editing = { label, buffer: secret ? "" : current, secret, fresh: !secret && current.length > 0, commit };
    this.refresh();
  }

  private providerFields(screen: Extract<Screen, { kind: "providerForm" }>): FormField[] {
    const draft = screen.draft;
    const write = (patch: Partial<ProviderDraft>) => {
      this.screen = { ...screen, draft: { ...draft, ...patch } };
      this.refresh();
    };
    return [
      {
        label: "接入 ID",
        value: draft.id || "(必填)",
        edit: screen.isNew ? () => this.textField("接入 ID", draft.id, false, (value) => write({ id: value.trim() })) : undefined,
      },
      { label: "名称", value: draft.name || "(未设置)", edit: () => this.textField("名称", draft.name ?? "", false, (value) => write({ name: value })) },
      {
        label: "协议",
        value: draft.api,
        cycle: (delta) => {
          const list = SUPPORTED_APIS as readonly ProviderApi[];
          write({ api: list[this.move(list.indexOf(draft.api), delta, list.length)] });
        },
      },
      { label: "Base URL", value: draft.baseUrl || "(必填)", edit: () => this.textField("Base URL", draft.baseUrl, false, (value) => write({ baseUrl: value.trim() })) },
      {
        label: "API Key",
        value: draft.apiKey ? redactSecret(draft.apiKey) : "(未设置，可填 $ENV 或 !command)",
        edit: () => this.textField("API Key", draft.apiKey ?? "", true, (value) => write({ apiKey: value.trim() })),
      },
      { label: "authHeader", value: draft.authHeader ? "开" : "关", cycle: () => write({ authHeader: !draft.authHeader }) },
      {
        label: "请求头",
        value: draft.headers && Object.keys(draft.headers).length > 0 ? JSON.stringify(draft.headers) : "(未设置)",
        edit: () =>
          this.textField("请求头 JSON", draft.headers ? JSON.stringify(draft.headers) : "", false, (value) => {
            const parsed = parseHeaders(value);
            if (parsed instanceof Error) {
              this.refresh(parsed.message, "warning");
              return;
            }
            write({ headers: parsed });
          }),
      },
    ];
  }

  private modelFields(screen: Extract<Screen, { kind: "modelForm" }>): FormField[] {
    const draft = screen.draft;
    const write = (patch: Partial<ModelDraft>) => {
      this.screen = { ...screen, draft: { ...draft, ...patch } };
      this.refresh();
    };
    const numberField = (label: string, current: number | undefined, commit: (value: number | undefined) => void) => {
      this.textField(label, current === undefined ? "" : String(current), false, (value) => {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
          commit(undefined);
          return;
        }
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          this.refresh(`${label} 必须是正整数`, "warning");
          return;
        }
        commit(parsed);
      });
    };
    return [
      {
        label: screen.target === "override" ? "模型 ID（内置）" : "模型 ID",
        value: draft.id || "(必填)",
        edit: screen.isNew ? () => this.textField("模型 ID", draft.id, false, (value) => write({ id: value.trim() })) : undefined,
      },
      { label: "显示名称", value: draft.name || "(未设置)", edit: () => this.textField("显示名称", draft.name ?? "", false, (value) => write({ name: value })) },
      {
        label: "上下文窗口",
        value: draft.contextWindow === undefined ? "(未设置)" : String(draft.contextWindow),
        edit: () => numberField("上下文窗口", draft.contextWindow, (value) => write({ contextWindow: value })),
      },
      {
        label: "最大输出",
        value: draft.maxTokens === undefined ? "(未设置)" : String(draft.maxTokens),
        edit: () => numberField("最大输出", draft.maxTokens, (value) => write({ maxTokens: value })),
      },
      { label: "思考", value: draft.reasoning ? "开" : "关", cycle: () => write({ reasoning: !draft.reasoning }) },
      { label: "图片输入", value: draft.image ? "开" : "关", cycle: () => write({ image: !draft.image }) },
    ];
  }

  // --- rendering ----------------------------------------------------------------

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    this.cachedWidth = width;
    this.cachedLines =
      this.screen.kind === "providers"
        ? this.renderProviders(width)
        : this.screen.kind === "models"
          ? this.renderModels(width, this.screen.providerId)
          : this.screen.kind === "providerForm"
            ? this.renderProviderForm(width)
            : this.screen.kind === "modelForm"
              ? this.renderModelForm(width)
              : this.renderFetch(width);
    return this.cachedLines;
  }

  private footer(actions: readonly KeyHint[], width: number): string[] {
    if (this.editing) return hintLines([{ keys: "Enter", label: "确认" }, { keys: "Esc", label: "取消" }], width);
    if (this.pendingConfirm) return hintLines([{ keys: "y", label: "确认删除" }, { keys: "其他键", label: "取消" }], width);
    return hintLines(actions, width);
  }

  /**
   * The line above the hints: what just happened, or what is being asked.
   *
   * Hints are rendered separately and always. Replacing them with a status
   * message leaves the reader without any way to see what the keys do.
   */
  private notice(): { text: string; tone: "dim" | "warning" | "error" } | undefined {
    if (this.editing) {
      const marker = this._focused ? CURSOR_MARKER : "";
      const shown = this.editing.secret ? "•".repeat(this.editing.buffer.length) : this.editing.buffer;
      const rule = this.editing.fresh ? "（输入即替换，Backspace 逐字删）" : "";
      return { text: `${this.editing.label}: ${shown}${marker}▌ ${rule}`, tone: "dim" };
    }
    if (this.pendingConfirm) return { text: this.pendingConfirm.prompt, tone: "warning" };
    return this.status ?? undefined;
  }

  /**
   * Sets a transient message and drops it after a moment so it does not become
   * furniture. Problems persist until the next action replaces them.
   */
  private setStatus(text: string | undefined, tone: "dim" | "warning" | "error" = "dim"): void {
    if (this.statusTimer !== null) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    this.status = text === undefined ? null : { text, tone };
    if (text !== undefined && tone === "dim") {
      this.statusTimer = setTimeout(() => {
        this.statusTimer = null;
        this.status = null;
        this.invalidate();
        this.tui.requestRender();
      }, NOTICE_TTL_MS);
      this.statusTimer.unref?.();
    }
  }

  /**
   * Marker for the focused row.
   *
   * The row is also background-highlighted, but a colour alone is invisible on
   * themes with a subtle `selectedBg` and in terminals without colour support.
   */
  private markerFor<T>(rows: readonly T[], selected: number): (row: T) => string {
    const focused = rows[selected];
    return (row) => (row === focused ? SELECTED_MARKER : UNSELECTED_MARKER);
  }

  private renderProviders(width: number): string[] {
    const rows = this.providerRows();
    const screen = this.screen as Extract<Screen, { kind: "providers" }>;
    const selected = Math.min(screen.index, Math.max(0, rows.length - 1));
    const configuredCount = rows.filter((row) => row.inConfig).length;
    const loggedIn = rows.filter((row) => !row.inConfig && row.auth.configured).length;
    const modelTotal = rows.reduce((total, row) => total + row.modelCount, 0);
    const columns: Column<ProviderRow>[] = [
      { title: "接入", width: "flex", value: (row) => row.id },
      { title: "协议", width: 22, value: (row) => row.api ?? (row.inConfig ? "继承内置" : "内置") },
      { title: "认证", width: 9, value: (row) => row.auth.label },
      { title: "来源", width: 6, value: (row) => (row.inConfig ? "配置" : "内置") },
      { title: "模型", width: 5, right: true, value: (row) => String(row.modelCount) },
    ];
    return frame({
      theme: this.theme,
      width,
      title: `Pi 模型配置 · 已配置 ${configuredCount} · 已登录 ${loggedIn} · 模型 ${modelTotal}`,
      meta: [modelsJsonPath()],
      body: table({
        theme: this.theme,
        width,
        columns,
        rows,
        selected,
        marker: this.markerFor(rows, selected),
        empty: "没有任何接入配置。按 n 新建（只需 Base URL + API Key）；按 b 显示 Pi 内置接入，以给内置模型写覆盖。",
        maxRows: this.maxListRows(),
      }),
      footer: this.footer(PROVIDER_ACTIONS, width),
      notice: this.notice(),
    });
  }

  private renderModels(width: number, providerId: string): string[] {
    const screen = this.screen as Extract<Screen, { kind: "models" }>;
    const entry = this.providerEntry(providerId);
    const rows = this.modelRows(providerId);
    const selected = Math.min(screen.index, Math.max(0, rows.length - 1));
    const defaults = this.providerDefaults(providerId);
    const baseUrl = (typeof entry?.baseUrl === "string" && entry.baseUrl) || defaults.baseUrl;
    const apiKey = typeof entry?.apiKey === "string" ? redactSecret(entry.apiKey) : "(未设置)";
    const columns: Column<ModelRow>[] = [
      { title: "模型", width: "flex", value: (row) => `${row.current ? "★ " : ""}${row.id}` },
      { title: "上下文", width: 7, right: true, value: (row) => compactCount(row.contextWindow) },
      { title: "输出", width: 7, right: true, value: (row) => compactCount(row.maxTokens) },
      { title: "能力", width: 12, value: (row) => describeCapabilities(row) },
      { title: "来源", width: 6, value: (row) => ORIGIN_LABEL[row.origin] },
    ];
    const footer = this.footer(MODEL_ACTIONS, width);
    return frame({
      theme: this.theme,
      width,
      title: `接入 ${providerId}${entry ? "" : "（内置，尚无配置）"}`,
      meta: [`${baseUrl ?? "(未设置 Base URL)"} · API Key ${apiKey}`, `模型 ${rows.length} 个（配置 ${rows.filter((row) => row.inConfig).length} 个，内置 ${rows.filter((row) => !row.inConfig).length} 个）`],
      body: table({
        theme: this.theme,
        width,
        columns,
        rows,
        selected,
        marker: this.markerFor(rows, selected),
        empty: "该接入还没有模型。按 f 从上游获取，或按 a 手动添加。",
        maxRows: this.maxListRows(),
      }),
      footer,
      notice: this.notice(),
    });
  }

  private renderProviderForm(width: number): string[] {
    const screen = this.screen as Extract<Screen, { kind: "providerForm" }>;
    return this.renderForm(width, `接入${screen.isNew ? "" : ` ${screen.providerId}`}`, this.providerFields(screen), screen.field, screen.isNew);
  }

  private renderModelForm(width: number): string[] {
    const screen = this.screen as Extract<Screen, { kind: "modelForm" }>;
    const isOverride = screen.target === "override";
    const label = isOverride ? "覆盖" : "模型";
    const hint = isOverride
      ? "写入 modelOverrides，只写你填过的字段；全部清空即删除覆盖"
      : "留空并保存即删除该项；表单未列出的字段会原样保留";
    const meta = [hint];
    if (isOverride) {
      // The form has no prefilled catalog values, so state what is in effect.
      const effective = this.host.catalogModels(screen.providerId).find((model) => model.id === screen.originalId);
      if (effective) {
        meta.push(
          `当前生效：上下文 ${compactCount(effective.contextWindow)} · 输出 ${compactCount(effective.maxTokens)} · 思考 ${effective.reasoning ? "开" : "关"} · 图片 ${effective.image ? "开" : "关"}`,
        );
      }
    }
    return this.renderForm(width, `${label}${screen.isNew ? "" : ` ${screen.originalId}`}`, this.modelFields(screen), screen.field, screen.isNew, meta);
  }

  private renderForm(width: number, what: string, fields: FormField[], selected: number, isNew: boolean, meta?: string[]): string[] {
    const columns: Column<FormField>[] = [
      { title: "字段", width: 13, value: (row) => row.label },
      { title: "", width: "flex", value: (row) => row.value },
    ];
    const footer = this.footer(FORM_ACTIONS, width);
    return frame({
      theme: this.theme,
      width,
      title: `${isNew ? "新建" : "编辑"}${what}`,
      meta: this.editing ? [] : (meta ?? ["留空并保存即删除该项；表单未列出的字段会原样保留"]),
      body: table({ theme: this.theme, width, columns, rows: fields, selected, empty: "", maxRows: this.maxListRows(), marker: this.markerFor(fields, selected) }),
      footer,
      notice: this.notice(),
    });
  }

  private renderFetch(width: number): string[] {
    const screen = this.screen as Extract<Screen, { kind: "fetch" }>;
    const rows = screen.rows;
    const selected = Math.min(screen.index, Math.max(0, rows.length - 1));
    const columns: Column<FetchRow>[] = [
      { title: "", width: 3, value: (row) => (screen.checked.has(row.model.id) ? "[x]" : "[ ]") },
      { title: "模型", width: "flex", value: (row) => row.model.id },
      { title: "上下文", width: 8, right: true, value: (row) => markValue(compactCount(row.model.contextWindow), row.model.sources.contextWindow) },
      { title: "输出", width: 8, right: true, value: (row) => markValue(compactCount(row.model.maxTokens), row.model.sources.maxTokens) },
      { title: "能力", width: 13, value: (row) => describeCapabilities(row.model, row.model.sources) },
      { title: "状态", width: 6, value: (row) => STATUS_LABEL[row.state] },
    ];
    const footer = this.footer(FETCH_ACTIONS, width);
    return frame({
      theme: this.theme,
      width,
      title: `从上游获取模型 · ${screen.providerId}`,
      meta: [
        `已勾选 ${screen.checked.size} / ${rows.length} · 新增项默认已勾选，值不同的需按 u 勾选才会改写`,
        "* 来自 Pi 内置目录（上游未提供）   ? 按模型名推断",
      ],
      body: table({
        theme: this.theme,
        width,
        columns,
        rows,
        selected,
        marker: this.markerFor(rows, selected),
        empty: "上游没有返回任何模型",
        maxRows: this.maxListRows(),
      }),
      footer,
      notice: this.notice(),
    });
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

function toEntry(model: DiscoveredModel): ModelEntry {
  const entry: ModelEntry = { id: model.id };
  if (model.name) entry.name = model.name;
  if (model.reasoning) entry.reasoning = true;
  if (model.image) entry.input = ["text", "image"];
  if (model.contextWindow !== undefined) entry.contextWindow = model.contextWindow;
  if (model.maxTokens !== undefined) entry.maxTokens = model.maxTokens;
  return entry;
}
