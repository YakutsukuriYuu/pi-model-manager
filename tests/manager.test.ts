import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelEntry, ProviderEntry } from "../src/models-json.ts";
import {
  MODEL_FORM_KEYS,
  applyExtras,
  applyModelDraft,
  applyProviderDraft,
  buildModelRows,
  buildProviderRows,
  describeCapabilities,
  draftFromModel,
  draftFromProvider,
  extrasOf,
  markValue,
  parseExtras,
  parseHeaders,
  redactSecret,
  validateModelDraft,
  validateProviderDraft,
} from "../src/ui/manager.ts";

test("provider rows put configured providers first, then built-ins", () => {
  const config: Array<[string, ProviderEntry]> = [
    ["mimo", { api: "openai-responses", models: [{ id: "a" }, { id: "b" }] }],
    ["commandcode", { api: "openai-completions", models: [{ id: "c" }] }],
  ];
  const counts = new Map([
    ["anthropic", 7],
    ["mimo", 2],
  ]);
  const rows = buildProviderRows(config, ["anthropic", "openai", "mimo"], counts);

  assert.deepEqual(rows.map((row) => row.id), ["commandcode", "mimo", "anthropic", "openai"]);
  assert.deepEqual(rows.map((row) => row.inConfig), [true, true, false, false]);
  assert.equal(rows[1].modelCount, 2, "count comes from the config entries");
  assert.equal(rows[2].modelCount, 7, "built-ins fall back to Pi's catalog count");
  assert.equal(rows[3].api, undefined, "a built-in with no config has no api");
});

test("model rows merge config entries with Pi's catalog", () => {
  const config: ModelEntry[] = [
    { id: "configured-only" },
    { id: "both", contextWindow: 111 },
  ];
  const catalog = [
    { id: "both", contextWindow: 222, maxTokens: 333, reasoning: true, image: true },
    { id: "catalog-only" },
  ];
  const rows = buildModelRows(config, catalog, "both");

  assert.deepEqual(rows.map((row) => row.id), ["configured-only", "both", "catalog-only"]);
  assert.deepEqual(rows.map((row) => row.inConfig), [true, true, false]);
  assert.equal(rows[1].contextWindow, 111, "the configured value wins over the catalog");
  assert.equal(rows[1].maxTokens, 333, "missing fields fall back to the catalog");
  assert.equal(rows[1].reasoning, true);
  assert.equal(rows[1].image, true);
  assert.equal(rows[1].current, true);
  assert.equal(rows[0].current, false);
});

test("provider drafts reject invalid ids and URLs", () => {
  const base = { id: "ok", baseUrl: "https://api.example.com/v1", api: "openai-completions" as const, extras: {} };
  assert.equal(validateProviderDraft(base), undefined);
  assert.match(validateProviderDraft({ ...base, id: "-bad" }) ?? "", /接入 ID/);
  assert.match(validateProviderDraft({ ...base, id: "has space" }) ?? "", /接入 ID/);
  assert.match(validateProviderDraft({ ...base, baseUrl: "" }) ?? "", /不能为空/);
  assert.match(validateProviderDraft({ ...base, baseUrl: "ftp://x" }) ?? "", /http/);
  assert.match(validateProviderDraft({ ...base, baseUrl: "not a url" }) ?? "", /合法地址/);
});

test("model drafts reject empty ids and non-positive numbers", () => {
  assert.equal(validateModelDraft({ id: "m", extras: {} }), undefined);
  assert.match(validateModelDraft({ id: "  ", extras: {} }) ?? "", /不能为空/);
  assert.match(validateModelDraft({ id: "m", contextWindow: 0, extras: {} }) ?? "", /正整数/);
  assert.match(validateModelDraft({ id: "m", maxTokens: -1, extras: {} }) ?? "", /正整数/);
});

test("applying a provider draft preserves fields the form does not expose", () => {
  const existing: ProviderEntry = {
    baseUrl: "https://old.example.com",
    api: "openai-completions",
    // Owned by another tool; must not be lost.
    piModelManager: { managed: true },
    modelOverrides: { "m1": { name: "renamed" } },
    compat: { supportsDeveloperRole: false },
  };
  applyProviderDraft(existing, {
    id: "p",
    name: "New Name",
    baseUrl: "https://new.example.com/v1",
    api: "anthropic-messages",
    apiKey: "sk-literal",
    authHeader: true,
    extras: {},
  });

  assert.equal(existing.baseUrl, "https://new.example.com/v1");
  assert.equal(existing.api, "anthropic-messages");
  assert.equal(existing.name, "New Name");
  assert.equal(existing.authHeader, true);
  assert.deepEqual(existing.piModelManager, { managed: true });
  assert.deepEqual(existing.modelOverrides, { m1: { name: "renamed" } });
  assert.deepEqual(existing.compat, { supportsDeveloperRole: false });
});

test("clearing a provider field deletes the key instead of writing empty text", () => {
  const existing: ProviderEntry = { name: "x", apiKey: "sk-1", authHeader: true, headers: { A: "1" } };
  applyProviderDraft(existing, { id: "p", baseUrl: "https://a.example.com", api: "openai-completions", name: "  ", apiKey: "", extras: {} });

  assert.equal("name" in existing, false);
  assert.equal("apiKey" in existing, false);
  assert.equal("authHeader" in existing, false);
  assert.equal("headers" in existing, false);
});

test("applying a model draft keeps unrelated model metadata", () => {
  const existing: ModelEntry = {
    id: "m",
    thinkingLevelMap: { off: null, high: "high" },
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    headers: { "X-Tier": "pro" },
    contextWindow: 1000,
  };
  applyModelDraft(existing, { id: "m", reasoning: true, image: true, contextWindow: 2000, maxTokens: 500, extras: {} });

  assert.equal(existing.reasoning, true);
  assert.deepEqual(existing.input, ["text", "image"]);
  assert.equal(existing.contextWindow, 2000);
  assert.equal(existing.maxTokens, 500);
  assert.deepEqual(existing.thinkingLevelMap, { off: null, high: "high" });
  assert.deepEqual(existing.cost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(existing.headers, { "X-Tier": "pro" });
});

test("extras carry every field the form has no row for", () => {
  const entry = {
    id: "m",
    name: "n",
    contextWindow: 1000,
    cost: { input: 1 },
    thinkingLevelMap: { high: "high" },
    compat: { supportsStrictTools: true },
    samplingParams: { temperature: 1 },
    headers: { "X-Tier": "pro" },
    promptCache: { short: 300 },
  };
  assert.deepEqual(extrasOf(entry, MODEL_FORM_KEYS), {
    cost: { input: 1 },
    thinkingLevelMap: { high: "high" },
    compat: { supportsStrictTools: true },
    samplingParams: { temperature: 1 },
    headers: { "X-Tier": "pro" },
    promptCache: { short: 300 },
  });
  // Keys with their own row are not extras.
  for (const owned of ["id", "name", "contextWindow"]) {
    assert.equal(owned in extrasOf(entry, MODEL_FORM_KEYS), false);
  }
  assert.deepEqual(extrasOf(undefined, MODEL_FORM_KEYS), {});
});

test("applying extras replaces them, so removing one there removes it from the file", () => {
  const entry: Record<string, unknown> = { id: "m", cost: { input: 1 }, thinkingLevelMap: { high: "high" } };
  applyExtras(entry, MODEL_FORM_KEYS, { compat: { supportsStrictTools: true } });
  assert.deepEqual(entry, { id: "m", compat: { supportsStrictTools: true } });

  // The JSON row can never overwrite a field that has its own row, while
  // unknown keys still pass through.
  const second: Record<string, unknown> = { id: "m" };
  applyExtras(second, MODEL_FORM_KEYS, { id: "hijacked", reason: "x" });
  assert.deepEqual(second, { id: "m", reason: "x" });
});

test("the JSON row rejects keys that have a row of their own", () => {
  assert.deepEqual(parseExtras('{"cost":{"input":1}}', MODEL_FORM_KEYS), { cost: { input: 1 } });
  assert.deepEqual(parseExtras("   ", MODEL_FORM_KEYS), {}, "empty means no extras");
  assert.match((parseExtras('{"contextWindow":1}', MODEL_FORM_KEYS) as Error).message, /contextWindow/);
  assert.ok(parseExtras("not json", MODEL_FORM_KEYS) instanceof Error);
  assert.ok(parseExtras("[1]", MODEL_FORM_KEYS) instanceof Error);
});

test("a draft captures the extras so saving round-trips them", () => {
  const draft = draftFromModel({ id: "m", cost: { input: 3 }, headers: { "X-Tier": "pro" } }, undefined, "m");
  assert.deepEqual(draft.extras, { cost: { input: 3 }, headers: { "X-Tier": "pro" } });
});

test("turning image support off removes the input key so Pi's default applies", () => {
  const existing: ModelEntry = { id: "m", input: ["text", "image"] };
  applyModelDraft(existing, { id: "m", image: false, extras: {} });
  assert.equal("input" in existing, false);
});

test("drafts round-trip configured values and fall back to Pi's catalog", () => {
  const fromConfig = draftFromProvider("mimo", { name: "MiMo", baseUrl: "https://x/v1", api: "openai-responses", authHeader: false }, {});
  assert.equal(fromConfig.api, "openai-responses");
  assert.equal(fromConfig.authHeader, false);
  assert.equal(fromConfig.baseUrl, "https://x/v1");

  // A built-in provider with no config inherits what Pi resolves for it.
  const fromBuiltin = draftFromProvider("anthropic", undefined, { name: "Anthropic", baseUrl: "https://api.anthropic.com", api: "anthropic-messages" });
  assert.equal(fromBuiltin.name, "Anthropic");
  assert.equal(fromBuiltin.baseUrl, "https://api.anthropic.com");
  assert.equal(fromBuiltin.api, "anthropic-messages");

  // An unknown api value must not leak into the form.
  const unknown = draftFromProvider("weird", { api: "not-a-real-api" }, {});
  assert.equal(unknown.api, "openai-completions");

  const model = draftFromModel({ id: "m" }, { id: "m", contextWindow: 5000, reasoning: true, image: true });
  assert.equal(model.contextWindow, 5000);
  assert.equal(model.reasoning, true);
  assert.equal(model.image, true);
});

test("header parsing accepts JSON objects and rejects anything else", () => {
  assert.deepEqual(parseHeaders('{"X-A":"1"}'), { "X-A": "1" });
  assert.equal(parseHeaders("   "), undefined);
  assert.ok(parseHeaders("not json") instanceof Error);
  assert.ok(parseHeaders('["a"]') instanceof Error);
  assert.ok(parseHeaders('{"X-A":1}') instanceof Error);
});

test("secret display never reveals a literal key", () => {
  assert.equal(redactSecret("$MY_KEY"), "$MY_KEY", "env references are safe to show");
  assert.equal(redactSecret("!op read x"), "!op read x", "command references are safe to show");
  const shown = redactSecret("tp-cxt-abcdefghijklmnop");
  assert.equal(shown.includes("abcdefghij"), false);
  assert.equal(shown, "tp-c…nop");
  assert.equal(redactSecret("short"), "•••••");
});

test("capability and value labels carry their provenance", () => {
  assert.equal(describeCapabilities({}), "文本");
  assert.equal(describeCapabilities({ reasoning: true }), "思考");
  assert.equal(describeCapabilities({ reasoning: true, image: true }), "思考 图片");
  // upstream is unmarked; catalog and guesses are flagged.
  assert.equal(describeCapabilities({ reasoning: true }, { reasoning: "upstream" }), "思考");
  assert.equal(describeCapabilities({ reasoning: true }, { reasoning: "catalog" }), "思考*");
  assert.equal(describeCapabilities({ reasoning: true }, { reasoning: "guess" }), "思考?");
  assert.equal(describeCapabilities({ image: true }, { image: "guess" }), "图片?");

  assert.equal(markValue("1M", undefined), "1M");
  assert.equal(markValue("1M", "upstream"), "1M");
  assert.equal(markValue("1M", "catalog"), "1M*");
  assert.equal(markValue("—", undefined), "—", "an unknown value keeps its placeholder");
});
