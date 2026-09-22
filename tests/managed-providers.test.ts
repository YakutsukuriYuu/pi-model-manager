import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import type { Api, Credential, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { buildManagedProvider, modelsUrl, parseDiscoveredModels, type ManagedProviderConfig } from "../src/managed-providers.ts";

/** Minimal stand-in for the discovery endpoint. */
async function withServer(
  handler: (url: string, headers: http.IncomingHttpHeaders) => { status: number; body: unknown },
  run: (baseUrl: string, requests: string[]) => Promise<void>,
): Promise<void> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    const { status, body } = handler(req.url ?? "", req.headers);
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind a port");
  try {
    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const MODEL_PAYLOAD = {
  data: [
    { id: "mock-chat" },
    { id: "mock-vision-pro", context_window: 200_000, max_tokens: 32_000 },
  ],
};

interface ContextOptions {
  apiKey?: string;
  stored?: readonly Model<Api>[];
  allowNetwork?: boolean;
  signal?: AbortSignal;
}

/** Builds the subset of RefreshModelsContext that this extension reads. */
function makeContext(options: ContextOptions = {}): {
  context: RefreshModelsContext;
  persisted: Model<Api>[][];
  credential: Credential | undefined;
} {
  const persisted: Model<Api>[][] = [];
  const credential: Credential | undefined =
    options.apiKey === undefined ? undefined : { type: "api_key", key: options.apiKey };
  const context = {
    credential,
    stored: options.stored ? { models: options.stored } : undefined,
    allowNetwork: options.allowNetwork ?? true,
    signal: options.signal ?? new AbortController().signal,
    async publish(publication: { persist?: { models?: readonly Model<Api>[] } | null; update?: () => void }) {
      publication.update?.();
      if (publication.persist?.models) persisted.push([...publication.persist.models]);
      return true;
    },
  };
  return { context: context as unknown as RefreshModelsContext, persisted, credential };
}

test("modelsUrl follows each SDK's own API path rules", () => {
  const url = (api: ManagedProviderConfig["api"], baseUrl: string) =>
    modelsUrl({ id: "pi-auto-x", name: "x", api, baseUrl });

  // Anthropic's SDK appends /v1 itself, including for gateway paths.
  assert.equal(url("anthropic-messages", "https://api.anthropic.com"), "https://api.anthropic.com/v1/models");
  assert.equal(url("anthropic-messages", "https://api.minimax.io/anthropic"), "https://api.minimax.io/anthropic/v1/models");
  // A base that already carries /v1 must not double it.
  assert.equal(url("anthropic-messages", "https://api.anthropic.com/v1"), "https://api.anthropic.com/v1/models");
  // OpenAI SDKs append no version segment.
  assert.equal(url("openai-completions", "https://api.example.com/v1"), "https://api.example.com/v1/models");
  assert.equal(url("openai-responses", "https://gw.example.com"), "https://gw.example.com/models");
  // Google's base already carries /v1beta.
  assert.equal(
    url("google-generative-ai", "https://generativelanguage.googleapis.com/v1beta"),
    "https://generativelanguage.googleapis.com/v1beta/models",
  );
  // Explicit overrides win, absolute or relative.
  assert.equal(modelsUrl({ id: "pi-auto-x", name: "x", api: "openai-completions", baseUrl: "https://a.io/v1", modelsPath: "https://other.io/list" }), "https://other.io/list");
  assert.equal(modelsUrl({ id: "pi-auto-x", name: "x", api: "openai-completions", baseUrl: "https://a.io/v1", modelsPath: "/catalog" }), "https://a.io/v1/catalog");
});

test("discovery parses OpenAI, Anthropic, and Google shapes", () => {
  const openai = parseDiscoveredModels({ data: [{ id: "gpt-x" }] });
  assert.deepEqual(openai.map((m) => m.id), ["gpt-x"]);

  const anthropic = parseDiscoveredModels({ data: [{ id: "claude-y", display_name: "Claude Y" }] });
  assert.equal(anthropic[0].name, "Claude Y");

  const google = parseDiscoveredModels({
    models: [{ name: "models/gemini-z", displayName: "Gemini Z", inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 }],
  });
  assert.equal(google[0].id, "gemini-z");
  assert.equal(google[0].name, "Gemini Z");
  assert.equal(google[0].contextWindow, 1_048_576);
  assert.equal(google[0].maxTokens, 65_536);

  // Unknown shapes must not throw.
  assert.deepEqual(parseDiscoveredModels({ nope: true }), []);
  assert.deepEqual(parseDiscoveredModels(null), []);
  // Duplicate ids collapse.
  assert.equal(parseDiscoveredModels({ data: [{ id: "a" }, { id: "a" }] }).length, 1);
});

test("refresh fetches and persists the catalog when network is allowed", async () => {
  await withServer(
    () => ({ status: 200, body: MODEL_PAYLOAD }),
    async (baseUrl, requests) => {
      const config: ManagedProviderConfig = { id: "pi-auto-fetch", name: "Fetch", api: "openai-completions", baseUrl: `${baseUrl}/v1` };
      const { context, persisted } = makeContext({ apiKey: "secret-key" });
      const models = await buildManagedProvider(config).refreshModels(context);

      assert.deepEqual(models.map((m) => m.id), ["mock-chat", "mock-vision-pro"]);
      assert.equal(models[1].contextWindow, 200_000);
      assert.equal(models[1].input.includes("image"), true);
      assert.deepEqual(requests, ["/v1/models"]);
      // Persisted entries must be full models so a later run can restore them.
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0].length, 2);
      assert.equal(persisted[0][0].provider, "pi-auto-fetch");
      assert.equal(persisted[0][0].api, "openai-completions");
      assert.equal(persisted[0][0].baseUrl, `${baseUrl}/v1`);
    },
  );
});

test("refresh serves the persisted catalog without touching the network when offline", async () => {
  await withServer(
    () => ({ status: 500, body: {} }),
    async (baseUrl, requests) => {
      const config: ManagedProviderConfig = { id: "pi-auto-offline", name: "Offline", api: "openai-completions", baseUrl: `${baseUrl}/v1` };
      const stored: Model<Api>[] = [
        {
          id: "restored-model",
          name: "Restored",
          api: "openai-completions",
          provider: "pi-auto-offline",
          baseUrl: `${baseUrl}/v1`,
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 99_000,
          maxTokens: 4_096,
        },
      ];
      const { context } = makeContext({ apiKey: "secret-key", allowNetwork: false, stored });
      const models = await buildManagedProvider(config).refreshModels(context);

      assert.deepEqual(models.map((m) => m.id), ["restored-model"]);
      assert.equal(models[0].contextWindow, 99_000);
      assert.equal(models[0].reasoning, true);
      assert.deepEqual(models[0].input, ["text", "image"]);
      assert.deepEqual(requests, [], "offline refresh must not make a network request");
    },
  );
});

test("refresh leaves models intact instead of wiping them on failure", async () => {
  await withServer(
    () => ({ status: 401, body: { error: "invalid api key" } }),
    async (baseUrl) => {
      const config: ManagedProviderConfig = { id: "pi-auto-fail", name: "Fail", api: "openai-completions", baseUrl: `${baseUrl}/v1` };
      const provider = buildManagedProvider(config);

      // First a good run, so a catalog exists in memory.
      const good = makeContext({ apiKey: "k" });
      await assert.rejects(async () => {
        await provider.refreshModels(good.context);
      }, /401/);

      // A failing refresh must surface an error and publish nothing.
      assert.equal(good.persisted.length, 0);
    },
  );
});

test("refresh without a credential is quiet and never fetches", async () => {
  await withServer(
    () => ({ status: 200, body: MODEL_PAYLOAD }),
    async (baseUrl, requests) => {
      const config: ManagedProviderConfig = { id: "pi-auto-noauth", name: "NoAuth", api: "openai-completions", baseUrl: `${baseUrl}/v1` };
      const { context, persisted } = makeContext();
      const models = await buildManagedProvider(config).refreshModels(context);

      assert.deepEqual(models, []);
      assert.deepEqual(persisted, []);
      assert.deepEqual(requests, []);
    },
  );
});

test("refresh keeps the catalog when the signal is already aborted", async () => {
  await withServer(
    () => ({ status: 200, body: MODEL_PAYLOAD }),
    async (baseUrl, requests) => {
      const config: ManagedProviderConfig = { id: "pi-auto-abort", name: "Abort", api: "openai-completions", baseUrl: `${baseUrl}/v1` };
      const { context, persisted } = makeContext({ apiKey: "k", signal: AbortSignal.abort() });
      const models = await buildManagedProvider(config).refreshModels(context);

      assert.deepEqual(models, []);
      assert.deepEqual(persisted, []);
      assert.deepEqual(requests, []);
    },
  );
});
