import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  backupPath,
  ensureProvider,
  findModel,
  hasJsonComments,
  modelEntries,
  modelsJsonPath,
  providerEntries,
  readModels,
  removeModel,
  removeProvider,
  restoreModels,
  stripJsonComments,
  upsertModel,
  writeModels,
} from "../src/models-json.ts";

/**
 * getAgentDir() reads PI_CODING_AGENT_DIR on every call, so pointing it at a
 * throwaway directory keeps these tests away from the real models.json.
 */
const agentDir = mkdtempSync(join(tmpdir(), "pmm-models-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const path = modelsJsonPath();

function reset(content?: string): void {
  rmSync(path, { force: true });
  rmSync(backupPath(), { force: true });
  if (content !== undefined) writeFileSync(path, content);
}

test("the fixture never points at the real agent directory", () => {
  assert.ok(path.startsWith(agentDir), `expected ${path} inside ${agentDir}`);
  assert.equal(path, join(agentDir, "models.json"));
});

test("a missing file reads as an empty document", () => {
  reset();
  const loaded = readModels();
  assert.deepEqual(loaded.doc, {});
  assert.equal(loaded.raw, undefined);
  assert.equal(loaded.hadComments, false);
});

test("JSONC is read, and comments are reported", () => {
  reset(`{
  // provider list
  "providers": {
    "a": { "baseUrl": "https://api.example.com/v1", "api": "openai-completions" } /* inline */
  }
}
`);
  const loaded = readModels();
  assert.equal(loaded.hadComments, true);
  assert.equal(get(loaded.doc, "a").baseUrl, "https://api.example.com/v1");
});

test("a trailing newline alone is not reported as a comment", () => {
  reset(`{"providers":{}}\n`);
  assert.equal(readModels().hadComments, false);
});

test("URLs inside strings are not mistaken for comments", () => {
  const text = '{"baseUrl":"https://api.example.com/v1"}';
  assert.equal(stripJsonComments(text), text);
  assert.equal(hasJsonComments(text), false);
});

test("write keeps unknown keys, sets 0600, and backs up the previous file", () => {
  reset();
  writeModels({
    providers: {
      "mimo": {
        baseUrl: "https://example.com/v1",
        api: "openai-responses",
        // Written by another tool; must survive our edits.
        piModelManager: { managed: true },
        models: [{ id: "m1", reasoning: true }],
      },
    },
  });

  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(existsSync(backupPath()), false, "no backup on first write");

  const first = readModels();
  assert.deepEqual(get(first.doc, "mimo").piModelManager, { managed: true });

  writeModels({ ...first.doc });
  assert.equal(existsSync(backupPath()), true, "second write backs up");
  assert.match(readFileSync(backupPath(), "utf8"), /piModelManager/);
});

test("restoreModels puts the previous content back and removes a created file", () => {
  reset(`{"providers":{"orig":{}}}\n`);
  const original = readModels().raw;
  writeModels({ providers: { changed: {} } });
  assert.deepEqual(providerEntries(readModels().doc).map(([id]) => id), ["changed"]);

  restoreModels(original);
  assert.deepEqual(providerEntries(readModels().doc).map(([id]) => id), ["orig"]);

  restoreModels(undefined);
  assert.equal(existsSync(path), false, "undefined means the file did not exist");
});

test("provider helpers create, replace, and remove without inventing keys", () => {
  const doc: Record<string, unknown> = {};
  const provider = ensureProvider(doc as never, "a");
  assert.equal("models" in provider, false, "a new provider must not declare an empty models array");
  // The same entry is returned rather than replaced.
  assert.equal(ensureProvider(doc as never, "a"), provider);

  upsertModel(provider, { id: "m1" });
  upsertModel(provider, { id: "m2" });
  assert.deepEqual(modelEntries(provider).map((entry) => entry.id), ["m1", "m2"]);

  // Replacing keeps position, so catalog order stays stable.
  upsertModel(provider, { id: "m1", reasoning: true });
  assert.deepEqual(modelEntries(provider).map((entry) => entry.id), ["m1", "m2"]);
  assert.equal(findModel(provider, "m1")?.reasoning, true);

  removeModel(provider, "m1");
  assert.deepEqual(modelEntries(provider).map((entry) => entry.id), ["m2"]);
  removeModel(provider, "m2");
  assert.equal("models" in provider, false, "an empty models array is dropped");

  removeProvider(doc as never, "a");
  // Pi requires the `providers` key, so it is kept even when empty. Writing
  // `{}` would be rejected as an invalid schema and roll the save back.
  assert.deepEqual(doc, { providers: {} });
});

test("a provider with only unparseable model entries yields no models", () => {
  const provider = ensureProvider({} as never, "a");
  provider.models = [{ nope: true } as never, { id: "ok" }];
  assert.deepEqual(modelEntries(provider).map((entry) => entry.id), ["ok"]);
});

test("a document without providers is still written in a form Pi accepts", () => {
  reset();
  // Pi declares `providers` as required and rejects `{}` wholesale, so the
  // writer must never emit a document that omits the key.
  writeModels({});
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { providers: {} });

  const cleared = { providers: { a: { baseUrl: "https://x/v1", api: "openai-completions" } } };
  removeProvider(cleared as never, "a");
  writeModels(cleared);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { providers: {} });
});

test("cleanup", () => {
  rmSync(agentDir, { recursive: true, force: true });
});

function get(doc: unknown, id: string) {
  const found = providerEntries(doc as never).find(([key]) => key === id);
  assert.ok(found, `provider ${id} missing`);
  return found[1];
}
