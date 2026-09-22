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
    discovered?: DiscoveredModel[];
    saveOk?: boolean;
    saveError?: string;
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
    providerDefaults: (providerId) => ({ api: options.catalog?.[providerId] ? "openai-completions" : undefined }),
    fetchModels: async () => options.discovered ?? [],
    currentModelId: () => undefined,
    setModel: async () => true,
    notify: () => {},
    close: () => {
      isClosed = true;
    },
  };
  const manager = new ModelManager({ requestRender: () => {} } as never, fakeTheme(), host.load(), host);
  return { manager, saved, doc: () => doc, closed: () => isClosed };
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
    discovered: [{ id: "new-model", contextWindow: 2000 }],
  });

  assertRenders(h.manager, "providers");
  h.manager.handleInput(KEY.enter);
  assertRenders(h.manager, "models");
  h.manager.handleInput("e");
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
  const h = harness({}, { discovered: [{ id: "auto-1" }, { id: "auto-2" }] });

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
    { id: "demo-model", contextWindow: 999 }, // already configured
    { id: "fresh-a", contextWindow: 5000, maxTokens: 1000, reasoning: true, inferredReasoning: true },
    { id: "fresh-b" },
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
  const h = harness(PROVIDER_DOC, { discovered: [{ id: "fresh-a" }, { id: "fresh-b" }] });
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("f");
  await tick();
  h.manager.handleInput(KEY.space); // untick the first
  h.manager.handleInput(KEY.enter);
  await tick();

  assert.deepEqual(h.saved.at(-1)?.providers?.demo.models?.map((model) => model.id), ["demo-model", "fresh-b"]);
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
  await tick();

  assert.equal(h.saved.length, 0);
  assert.match(h.manager.render(120).join("\n"), /已回滚.*Invalid models.json schema/su);
});

test("editing an existing provider keeps untouched fields", async () => {
  const h = harness(PROVIDER_DOC);
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("e");
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
  await tick();
  assert.deepEqual(h.saved.at(-1)?.providers, {});
});

test("deleting the last model drops the empty models array", async () => {
  const h = harness(PROVIDER_DOC);
  h.manager.handleInput(KEY.enter);
  h.manager.handleInput("d");
  await tick();
  assert.equal("models" in (h.saved.at(-1)?.providers?.demo ?? {}), false);
});

test("escape closes the manager from the provider list", () => {
  const h = harness(PROVIDER_DOC);
  h.manager.handleInput(KEY.escape);
  assert.equal(h.closed(), true);
});
