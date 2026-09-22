import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { DiscoveredModel } from "../src/discovery.ts";
import type { LoadedModels, ModelsDocument } from "../src/models-json.ts";
import { type CatalogModel, type ManagerHost, ModelManager } from "../src/ui/manager.ts";

/** Key sequences as pi-tui parses them. */
const KEY = {
  enter: "\r",
  escape: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  space: " ",
  backspace: "\x7f",
  save: "\x13",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  home: "\x1b[H",
  end: "\x1b[F",
};

function fakeTheme() {
  // SAFETY: the component only needs these three methods to exist.
  return { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
}

interface Harness {
  manager: ModelManager;
  saved: ModelsDocument[];
  doc(): ModelsDocument;
  closed(): boolean;
}

function harness(
  initial: ModelsDocument,
  options: {
    catalog?: Record<string, CatalogModel[]>;
    /** Pi's catalog used to fill blank fields, keyed by model id. */
    metadata?: Map<string, CatalogModel>;
    discovered?: DiscoveredModel[];
    saveOk?: boolean;
    saveError?: string;
    /** Terminal height the component budgets its list against. */
    terminalRows?: number;
  } = {},
): Harness {
  let doc = structuredClone(initial);
  const saved: ModelsDocument[] = [];
  let isClosed = false;
  const host: ManagerHost = {
    load: (): LoadedModels => ({ doc: structuredClone(doc), raw: JSON.stringify(doc), hadComments: false }),
    save: async (next) => {
      if (options.saveOk === false) return { ok: false, error: options.saveError ?? "boom" };
      saved.push(structuredClone(next));
      doc = structuredClone(next);
      return { ok: true };
    },
    catalogProviderIds: () => Object.keys(options.catalog ?? {}),
    catalogModels: (providerId) => options.catalog?.[providerId] ?? [],
    catalogMetadata: () => options.metadata ?? new Map(),
    providerDefaults: (providerId) => ({ api: options.catalog?.[providerId] ? "openai-completions" : undefined }),
    fetchModels: async () => options.discovered ?? [],
    currentModelId: () => undefined,
    setModel: async () => true,
    notify: () => {},
    close: () => {
      isClosed = true;
    },
  };
  const manager = new ModelManager(
    // SAFETY: the component only calls requestRender() and reads terminal.rows.
    { requestRender: () => {}, terminal: { rows: options.terminalRows ?? 40 } } as never,
    fakeTheme(),
    host.load(),
    host,
  );
  return { manager, saved, doc: () => doc, closed: () => isClosed };
}

/** Discovery results in tests carry no provenance unless stated. */
function dm(id: string, extra: Omit<Partial<DiscoveredModel>, "id"> = {}): DiscoveredModel {
  return { id, sources: {}, ...extra };
}

/** Async actions are started with `void`, so let the microtask queue drain. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function assertRenders(manager: ModelManager, label: string): void {
  for (const width of [50, 80, 120, 200]) {
    const lines = manager.render(width);
    assert.ok(lines.length > 0, `${label}: produced no lines at width ${width}`);
    for (const line of lines) {
      assert.ok(
        visibleWidth(line) <= width,
        `${label}: line exceeds width ${width} (${visibleWidth(line)}): ${JSON.stringify(line)}`,
      );
    }
    // Cached rendering must be stable.
    assert.deepEqual(manager.render(width), lines, `${label}: render is not stable at width ${width}`);
  }
  manager.invalidate();
}

const PROVIDER_DOC: ModelsDocument = {
  providers: {
    demo: {
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      apiKey: "$DEMO_KEY",
      // Written by another tool; every edit must leave it alone.
      piModelManager: { managed: true },
      models: [{ id: "demo-model", contextWindow: 1000, reasoning: true }],
    },
  },
};

test("renders every screen within the terminal width", async () => {
  const h = harness(PROVIDER_DOC, {
    catalog: { builtin: [{ id: "builtin-model", contextWindow: 500 }] },
    discovered: [dm("new-model", { contextWindow: 2000 })],
  });

  assertRenders(h.manager, "providers");
  h.manager.handleInput(KEY.enter);
  assertRenders(h.manager, "models");
  h.manager.handleInput("e");
  assertRenders(h.manager, "modelForm (edit existing)");
  h.manager.handleInput(KEY.escape);
  h.manager.handleInput("p");
  assertRenders(h.manager, "providerForm");
  h.manager.handleInput(KEY.down);
  h.manager.handleInput(KEY.right);
  assertRenders(h.manager, "providerForm after cycle");
  h.manager.handleInput(KEY.escape);
  h.manager.handleInput("a");
  assertRenders(h.manager, "modelForm");
  h.manager.handleInput(KEY.escape);
  h.manager.handleInput("f");
  await tick();
  assertRenders(h.manager, "fetch");
  h.manager.handleInput(KEY.escape);
  h.manager.handleInput(KEY.escape);
  assertRenders(h.manager, "back to providers");
});

test("creates a provider with only a base URL and an API key", async () => {
  const h = harness({}, { discovered: [dm("auto-1"), dm("auto-2")] });

  h.manager.handleInput("n");
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("my-provider");
  h.manager.handleInput(KEY.enter);
  // 名称 → 协议
  h.manager.handleInput(KEY.down);
  h.manager.handleInput(KEY.down);
  // Base URL
  h.manager.handleInput(KEY.down);
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("https://api.example.com/v1");
  h.manager.handleInput(KEY.enter);
  // API Key
  h.manager.handleInput(KEY.down);
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("sk-secret-value");
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput(KEY.save);
  await tick();

  const saved = h.saved.at(-1);
  assert.ok(saved, "nothing was saved");
  assert.deepEqual(Object.keys(saved.providers ?? {}), ["my-provider"]);
  const provider = saved.providers?.["my-provider"];
  assert.equal(provider?.baseUrl, "https://api.example.com/v1");
  assert.equal(provider?.apiKey, "sk-secret-value");
  assert.equal("models" in (provider ?? {}), false, "a new provider must not declare an empty models array");
});

test("fetches models and adds only the newly discovered ones", async () => {
  const discovered: DiscoveredModel[] = [
    dm("demo-model", { contextWindow: 999 }), // already configured with a different value
    dm("fresh-a", { contextWindow: 5000, maxTokens: 1000, reasoning: true, sources: { reasoning: "guess" } }),
    dm("fresh-b"),
  ];
  const h = harness(PROVIDER_DOC, { discovered });

  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("f");
  await tick();

  // Only the new models start checked.
  h.manager.handleInput(KEY.enter);
  await tick();

  const provider = h.saved.at(-1)?.providers?.demo;
  assert.deepEqual(
    provider?.models?.map((model) => model.id),
    ["demo-model", "fresh-a", "fresh-b"],
  );
  assert.equal(provider?.models?.[0].contextWindow, 1000, "an existing model must not be rewritten");
  assert.deepEqual(provider?.models?.[1], { id: "fresh-a", reasoning: true, contextWindow: 5000, maxTokens: 1000 });
  assert.deepEqual(provider?.models?.[2], { id: "fresh-b" });
  // Foreign keys survive the round trip.
  assert.deepEqual(provider?.piModelManager, { managed: true });
});

test("space deselects a model before saving", async () => {
  const h = harness(PROVIDER_DOC, { discovered: [dm("fresh-a"), dm("fresh-b")] });
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("f");
  await tick();
  h.manager.handleInput(KEY.space); // untick the first
  h.manager.handleInput(KEY.enter);
  await tick();

  assert.deepEqual(h.saved.at(-1)?.providers?.demo.models?.map((model) => model.id), ["demo-model", "fresh-b"]);
});

test("u opts in to rewriting entries whose values differ", async () => {
  const h = harness(PROVIDER_DOC, {
    discovered: [dm("demo-model", { contextWindow: 999 }), dm("same-model"), dm("fresh-a")],
  });
  // `same-model` is not configured, so add it first to make it an existing entry.
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("f");
  await tick();

  // Before pressing u only new models are selected.
  const shown = h.manager.render(120).join("\n");
  assert.match(shown, /新增/);
  assert.match(shown, /不同/);

  h.manager.handleInput("u");
  h.manager.handleInput(KEY.enter);
  await tick();

  const models = h.saved.at(-1)?.providers?.demo.models ?? [];
  assert.equal(models.find((model) => model.id === "demo-model")?.contextWindow, 999, "u rewrites the differing entry");
  assert.equal(models.find((model) => model.id === "fresh-a")?.id, "fresh-a");
});

test("values taken from Pi's catalog are marked as such", async () => {
  const h = harness(PROVIDER_DOC, {
    // Upstream reports nothing for this model except its id.
    discovered: [dm("catalog-known")],
    metadata: new Map([["catalog-known", { id: "catalog-known", contextWindow: 1_000_000, maxTokens: 64_000, reasoning: true }]]),
  });
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("f");
  await tick();

  const shown = h.manager.render(140).join("\n");
  assert.match(shown, /1M\*/, "a catalog-sourced context window is marked");
  assert.match(shown, /64k\*/);

  h.manager.handleInput(KEY.enter);
  await tick();
  const written = h.saved.at(-1)?.providers?.demo.models?.find((model) => model.id === "catalog-known");
  assert.equal(written?.contextWindow, 1_000_000);
  assert.equal(written?.maxTokens, 64_000);
  assert.equal(written?.reasoning, true);
});

test("refuses to save while a field is invalid and reports why", async () => {
  const h = harness({});
  h.manager.handleInput("n");
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("bad id with spaces");
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput(KEY.save);
  await tick();

  assert.equal(h.saved.length, 0, "an invalid draft must not be saved");
  const shown = h.manager.render(100).join("\n");
  assert.match(shown, /接入 ID/);
});

test("a failed save reports the rollback message", async () => {
  const h = harness(PROVIDER_DOC, { saveOk: false, saveError: "Invalid models.json schema" });
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("d");
  h.manager.handleInput("y");
  await tick();

  assert.equal(h.saved.length, 0);
  assert.match(h.manager.render(120).join("\n"), /已回滚.*Invalid models.json schema/su);
});

test("editing an existing provider keeps untouched fields", async () => {
  const h = harness(PROVIDER_DOC);
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("p");
  // Row 0 is 接入 ID, which is read-only for an existing provider.
  h.manager.handleInput(KEY.down);
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput(KEY.backspace);
  h.manager.handleInput("Renamed");
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput(KEY.save);
  await tick();

  const provider = h.saved.at(-1)?.providers?.demo;
  assert.equal(provider?.name, "Renamed");
  assert.equal(provider?.baseUrl, "https://api.example.com/v1");
  assert.equal(provider?.apiKey, "$DEMO_KEY");
  assert.deepEqual(provider?.piModelManager, { managed: true });
  assert.equal(provider?.models?.length, 1);
});

test("deleting removes the entry from the config only", async () => {
  const h = harness(PROVIDER_DOC, { catalog: { builtin: [{ id: "builtin-model" }] } });

  // A built-in provider cannot be deleted.
  h.manager.handleInput(KEY.down);
  h.manager.handleInput("d");
  await tick();
  assert.equal(h.saved.length, 0);

  // The configured provider can.
  h.manager.handleInput(KEY.up);
  h.manager.handleInput("d");
  h.manager.handleInput("y");
  await tick();
  assert.deepEqual(h.saved.at(-1)?.providers, {});
});

test("deleting the last model drops the empty models array", async () => {
  const h = harness(PROVIDER_DOC);
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("d");
  h.manager.handleInput("y");
  await tick();
  assert.equal("models" in (h.saved.at(-1)?.providers?.demo ?? {}), false);
});

test("edits an existing configured model in place", async () => {
  const h = harness(PROVIDER_DOC);
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("e");
  // Row 0 is the model id (read-only for an existing model); row 2 is 上下文窗口.
  h.manager.handleInput(KEY.down);
  h.manager.handleInput(KEY.down);
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("200000");
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput(KEY.save);
  await tick();

  const model = h.saved.at(-1)?.providers?.demo.models?.find((entry) => entry.id === "demo-model");
  assert.equal(model?.contextWindow, 200_000);
  assert.equal(model?.reasoning, true, "untouched fields survive");
  assert.equal(h.saved.at(-1)?.providers?.demo.baseUrl, "https://api.example.com/v1", "the provider is not rewritten");
});

/** A provider Pi ships: no models.json entry, models come from the catalog. */
const BUILTIN_CATALOG = { builtin: [{ id: "builtin-model", contextWindow: 128_000, maxTokens: 16_384 }] };

test("editing a built-in model writes a modelOverrides entry", async () => {
  const h = harness({}, { catalog: BUILTIN_CATALOG });
  h.manager.handleInput(KEY.enter); // into the built-in provider
  h.manager.handleInput("e");
  const form = h.manager.render(120).join("\n");
  assert.match(form, /覆盖/, "the form says it writes an override");
  assert.match(form, /128k/, "the catalog value prefills the form");

  // Row 2 is 上下文窗口; the prefilled value is replaced by the first keystroke.
  h.manager.handleInput(KEY.down);
  h.manager.handleInput(KEY.down);
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("500000");
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput(KEY.save);
  await tick();

  const provider = h.saved.at(-1)?.providers?.builtin;
  assert.deepEqual(provider?.modelOverrides, { "builtin-model": { contextWindow: 500_000 } });
  // Pi keeps its own catalog entry; no replacement model is added.
  assert.equal("models" in (provider ?? {}), false);
});

test("deleting an overridden built-in model removes only the override", async () => {
  const doc: ModelsDocument = { providers: { builtin: { modelOverrides: { "builtin-model": { contextWindow: 500_000 } } } } };
  const h = harness(doc, { catalog: BUILTIN_CATALOG });
  h.manager.handleInput(KEY.enter);
  assert.match(h.manager.render(120).join("\n"), /覆盖/);

  h.manager.handleInput("d");
  h.manager.handleInput("y");
  await tick();
  // The entry configured nothing else, and Pi rejects an empty provider, so it
  // is removed entirely rather than left behind.
  assert.deepEqual(h.saved.at(-1)?.providers, {});
});

test("clearing the last override drops the now-empty provider entry", async () => {
  const doc: ModelsDocument = { providers: { builtin: { modelOverrides: { "builtin-model": { contextWindow: 500_000 } } } } };
  const h = harness(doc, { catalog: BUILTIN_CATALOG });
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("e");
  // Clear 上下文窗口 by deleting the prefilled value one character at a time.
  h.manager.handleInput(KEY.down);
  h.manager.handleInput(KEY.down);
  h.manager.handleInput(KEY.enter);
  for (let i = 0; i < 6; i++) h.manager.handleInput(KEY.backspace);
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput(KEY.save);
  await tick();

  assert.deepEqual(h.saved.at(-1)?.providers, {}, "an empty provider entry would be rejected by Pi");
});

test("a built-in model with no override cannot be deleted", async () => {
  const h = harness({}, { catalog: BUILTIN_CATALOG });
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("d");
  await tick();

  assert.equal(h.saved.length, 0, "there is nothing to delete yet");
  assert.match(h.manager.render(140).join("\n"), /没有可删除的配置/);
});

test("a long model list scrolls with the cursor instead of running off screen", () => {
  const models = Array.from({ length: 69 }, (_, index) => ({ id: `model-${String(index).padStart(2, "0")}` }));
  const h = harness({ providers: { demo: { baseUrl: "https://api.example.com/v1", api: "openai-completions", models } } });

  h.manager.handleInput(KEY.enter);
  const visibleRows = (h.manager.render(120).length);
  assert.ok(visibleRows < 30, `frame should stay small, got ${visibleRows} lines`);

  // Walk to the very bottom of the list.
  for (let i = 0; i < 68; i++) h.manager.handleInput(KEY.down);
  const lines = h.manager.render(120);
  const shown = lines.join("\n");

  assert.ok(shown.includes("model-68"), "the selected row must be rendered");
  assert.ok(shown.includes("共 69 项"), "the scroll position must be reported");
  assert.equal(lines.length, visibleRows, "the frame height must not grow with the list");
  assert.ok(!shown.includes("model-00"), "rows scrolled past should not be rendered");

  // And back to the top.
  for (let i = 0; i < 68; i++) h.manager.handleInput(KEY.up);
  const top = h.manager.render(120).join("\n");
  assert.ok(top.includes("model-00"));
  assert.ok(!top.includes("model-68"));
});

test("the list gets shorter on a shorter terminal", () => {
  const models = Array.from({ length: 40 }, (_, index) => ({ id: `m-${index}` }));
  const doc: ModelsDocument = { providers: { demo: { baseUrl: "https://a/v1", api: "openai-completions", models } } };

  const tall = harness(doc, { terminalRows: 60 });
  tall.manager.handleInput(KEY.enter);
  const tallLines = tall.manager.render(120).length;

  const short = harness(doc, { terminalRows: 20 });
  short.manager.handleInput(KEY.enter);
  const shortLines = short.manager.render(120).length;

  assert.ok(shortLines < tallLines, `expected ${shortLines} < ${tallLines}`);

  // Selection stays visible even in the smallest case.
  for (let i = 0; i < 39; i++) short.manager.handleInput(KEY.down);
  assert.ok(short.manager.render(120).join("\n").includes("m-39"));
});

test("paging and Home/End move around a long list", () => {
  const models = Array.from({ length: 69 }, (_, index) => ({ id: `model-${String(index).padStart(2, "0")}` }));
  const h = harness({ providers: { demo: { baseUrl: "https://a/v1", api: "openai-completions", models } } }, { terminalRows: 40 });
  h.manager.handleInput(KEY.enter);
  const shown = () => h.manager.render(120).join("\n");

  h.manager.handleInput(KEY.end);
  assert.ok(shown().includes("› model-68"), "End jumps to the last row");

  h.manager.handleInput(KEY.home);
  assert.ok(shown().includes("› model-00"), "Home jumps to the first row");

  // One page equals the visible window, so the cursor lands near the bottom.
  h.manager.handleInput(KEY.pageDown);
  assert.ok(!shown().includes("› model-00"), "PgDn moves at least a screenful");
  assert.ok(shown().includes("› model-17"), `PgDn should move one page, got: ${shown().split("\n")[5]}`);

  h.manager.handleInput(KEY.pageUp);
  assert.ok(shown().includes("› model-00"), "PgUp comes back");

  // Paging must not wrap past the ends.
  h.manager.handleInput(KEY.pageUp);
  assert.ok(shown().includes("› model-00"));
  h.manager.handleInput(KEY.end);
  h.manager.handleInput(KEY.pageDown);
  assert.ok(shown().includes("› model-68"), "PgDn stops at the last row");
});

test("deleting asks for confirmation first", async () => {
  const h = harness(PROVIDER_DOC);
  // Model list → delete the one configured model.
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("d");
  await tick();
  assert.equal(h.saved.length, 0, "a single keystroke must not delete anything");
  assert.match(h.manager.render(120).join("\n"), /y 确认删除/);

  // Any other key cancels.
  h.manager.handleInput("n");
  await tick();
  assert.equal(h.saved.length, 0);
  assert.match(h.manager.render(120).join("\n"), /已取消/);

  // Confirming performs it.
  h.manager.handleInput("d");
  h.manager.handleInput("y");
  await tick();
  assert.equal(h.saved.length, 1);
  assert.equal("models" in (h.saved.at(-1)?.providers?.demo ?? {}), false);
});

test("deleting a provider asks for confirmation and names the model count", async () => {
  const h = harness(PROVIDER_DOC);
  h.manager.handleInput("d");
  await tick();

  const shown = h.manager.render(120).join("\n");
  assert.match(shown, /删除接入 demo 的配置（含 1 个模型）/);
  assert.equal(h.saved.length, 0);

  h.manager.handleInput("y");
  await tick();
  assert.deepEqual(h.saved.at(-1)?.providers, {});
});

test("escape closes the manager from the provider list", () => {
  const h = harness(PROVIDER_DOC);
  h.manager.handleInput(KEY.escape);
  assert.equal(h.closed(), true);
});
