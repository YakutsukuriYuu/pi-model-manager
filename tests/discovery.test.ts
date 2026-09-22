import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { fetchModels, modelsUrl, parseModels, partitionDiscovered, toModelEntry } from "../src/discovery.ts";

async function withServer(
  handler: (url: string, headers: http.IncomingHttpHeaders) => { status: number; body: unknown },
  run: (baseUrl: string, requests: Array<{ url: string; headers: http.IncomingHttpHeaders }>) => Promise<void>,
): Promise<void> {
  const requests: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? "", headers: req.headers });
    const { status, body } = handler(req.url ?? "", req.headers);
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  try {
    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("modelsUrl follows each SDK's own API path rules", () => {
  // Anthropic's SDK appends /v1 itself, including for gateway paths.
  assert.equal(modelsUrl("https://api.anthropic.com", "anthropic-messages"), "https://api.anthropic.com/v1/models");
  assert.equal(modelsUrl("https://api.minimax.io/anthropic", "anthropic-messages"), "https://api.minimax.io/anthropic/v1/models");
  // A base that already carries /v1 must not double it.
  assert.equal(modelsUrl("https://api.anthropic.com/v1", "anthropic-messages"), "https://api.anthropic.com/v1/models");
  // OpenAI SDKs append no version segment.
  assert.equal(modelsUrl("https://api.example.com/v1", "openai-completions"), "https://api.example.com/v1/models");
  assert.equal(modelsUrl("https://gw.example.com/", "openai-responses"), "https://gw.example.com/models");
  // Google's base already carries /v1beta.
  assert.equal(modelsUrl("https://generativelanguage.googleapis.com/v1beta", "google-generative-ai"), "https://generativelanguage.googleapis.com/v1beta/models");
});

test("parseModels reads OpenAI, Anthropic, Google, and OpenRouter shapes", () => {
  assert.deepEqual(parseModels({ data: [{ id: "gpt-x" }] }).map((m) => m.id), ["gpt-x"]);

  const anthropic = parseModels({ data: [{ id: "claude-y", display_name: "Claude Y" }] });
  assert.equal(anthropic[0].name, "Claude Y");

  const google = parseModels({
    models: [{ name: "models/gemini-z", displayName: "Gemini Z", inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 }],
  });
  assert.equal(google[0].id, "gemini-z");
  assert.equal(google[0].name, "Gemini Z");
  assert.equal(google[0].contextWindow, 1_048_576);
  assert.equal(google[0].maxTokens, 65_536);

  // OpenRouter-style: window and modalities nest differently, output cap lives under top_provider.
  const openrouter = parseModels({
    data: [{
      id: "vendor/model-a",
      context_length: 200_000,
      architecture: { input_modalities: ["text", "image"] },
      top_provider: { max_completion_tokens: 32_000 },
      supported_parameters: ["tools", "reasoning"],
    }],
  });
  assert.equal(openrouter[0].contextWindow, 200_000);
  assert.equal(openrouter[0].maxTokens, 32_000);
  assert.equal(openrouter[0].image, true);
  assert.equal(openrouter[0].reasoning, true);
  assert.equal(openrouter[0].inferredReasoning, undefined, "declared reasoning is not an inference");

  // Unknown shapes must not throw.
  assert.deepEqual(parseModels({ nope: true }), []);
  assert.deepEqual(parseModels(null), []);
  assert.equal(parseModels({ data: [{ id: "a" }, { id: "a" }, { noId: 1 }] }).length, 1);
});

test("capability inference only fires on unambiguous id markers and is flagged", () => {
  const [reasoning] = parseModels({ data: [{ id: "deepseek-reasoning-r1" }] });
  assert.equal(reasoning.reasoning, true);
  assert.equal(reasoning.inferredReasoning, true);
  assert.equal(reasoning.inferredImage, undefined);

  const [vision] = parseModels({ data: [{ id: "acme-vision-pro" }] });
  assert.equal(vision.image, true);
  assert.equal(vision.inferredImage, true);

  // Substring matches must not fire: "advisable" contains "vis".
  const [plain] = parseModels({ data: [{ id: "vendor/advisable-model" }] });
  assert.equal(plain.image, undefined);
  assert.equal(plain.reasoning, undefined);
});

test("toModelEntry writes only what upstream reported", () => {
  const [bare] = parseModels({ data: [{ id: "only-an-id" }] });
  assert.deepEqual(toModelEntry(bare), { id: "only-an-id" }, "no invented context window or max tokens");

  const [rich] = parseModels({ data: [{ id: "m", display_name: "M", context_length: 100_000, max_tokens: 8_000 }] });
  assert.deepEqual(toModelEntry(rich), { id: "m", name: "M", contextWindow: 100_000, maxTokens: 8_000 });
});

test("partitionDiscovered separates new models from already configured ones", () => {
  const discovered = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const { fresh, known } = partitionDiscovered([{ id: "b" }], discovered);
  assert.deepEqual(fresh.map((m) => m.id), ["a", "c"]);
  assert.deepEqual(known.map((m) => m.id), ["b"]);
});

test("fetchModels sends per-protocol auth headers", async () => {
  await withServer(
    () => ({ status: 200, body: { data: [{ id: "m1" }] } }),
    async (baseUrl, requests) => {
      await fetchModels({ baseUrl: `${baseUrl}/v1`, api: "openai-completions", apiKey: "k1" }, AbortSignal.timeout(5000));
      await fetchModels({ baseUrl, api: "anthropic-messages", apiKey: "k2" }, AbortSignal.timeout(5000));
      await fetchModels({ baseUrl: `${baseUrl}/v1beta`, api: "google-generative-ai", apiKey: "k3" }, AbortSignal.timeout(5000));

      assert.deepEqual(requests.map((r) => r.url), ["/v1/models", "/v1/models", "/v1beta/models"]);
      assert.equal(requests[0].headers.authorization, "Bearer k1");
      assert.equal(requests[1].headers["x-api-key"], "k2");
      assert.equal(requests[1].headers["anthropic-version"], "2023-06-01");
      assert.equal(requests[2].headers["x-goog-api-key"], "k3");
    },
  );
});

test("fetchModels reports HTTP failures with status and body", async () => {
  await withServer(
    () => ({ status: 401, body: { error: "invalid api key" } }),
    async (baseUrl) => {
      await assert.rejects(
        () => fetchModels({ baseUrl: `${baseUrl}/v1`, api: "openai-completions", apiKey: "bad" }, AbortSignal.timeout(5000)),
        /401.*invalid api key/su,
      );
    },
  );
});
