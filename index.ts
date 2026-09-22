import type { Model, Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type DiscoveredModel, type ProviderApi, fetchModels } from "./src/discovery.ts";
import { type ModelsDocument, providerEntries, readModels, restoreModels, writeModels } from "./src/models-json.ts";
import { type CatalogModel, type ManagerHost, type SaveResult, ModelManager } from "./src/ui/manager.ts";

const COMMAND = "models";
const DISCOVERY_TIMEOUT_MS = 15_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bridges the manager UI to Pi.
 *
 * Saving writes models.json and then asks Pi to reload it. Pi validates the
 * whole file and discards *every* provider when a single entry fails, so a
 * rejected write is rolled back immediately rather than leaving the user with
 * no models at all.
 */
function createHost(pi: ExtensionAPI, ctx: ExtensionContext, close: () => void): ManagerHost {
  const registry = ctx.modelRegistry;

  return {
    load: () => readModels(),

    async save(doc: ModelsDocument): Promise<SaveResult> {
      const previous = readModels().raw;
      try {
        writeModels(doc);
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
      // Reloads models.json without touching the network.
      await registry.refresh({ allowNetwork: false });
      const error = registry.getError();
      if (!error) return { ok: true };
      try {
        restoreModels(previous);
        await registry.refresh({ allowNetwork: false });
      } catch (restoreError) {
        return { ok: false, error: `${error}\n（回滚也失败：${errorMessage(restoreError)}）` };
      }
      return { ok: false, error };
    },

    catalogProviderIds(): string[] {
      const ids = new Set<string>();
      for (const model of registry.getAll()) ids.add(model.provider);
      for (const id of registry.getRegisteredProviderIds()) ids.add(id);
      return [...ids];
    },

    catalogModels(providerId: string): CatalogModel[] {
      return registry
        .getAll()
        .filter((model) => model.provider === providerId)
        .map((model) => ({
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          reasoning: model.reasoning,
          image: model.input.includes("image"),
        }));
    },

    /**
     * Pi's catalog keyed by model id.
     *
     * Providers defined in models.json are skipped: those entries are the
     * user's own configuration, and feeding them back as a reference would
     * launder stale values into "Pi says so" with no new information.
     */
    catalogMetadata(): Map<string, CatalogModel> {
      const configured = new Set(providerEntries(readModels().doc).map(([id]) => id));
      const index = new Map<string, CatalogModel>();
      for (const model of registry.getAll()) {
        if (configured.has(model.provider)) continue;
        if (index.has(model.id)) continue;
        index.set(model.id, {
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          reasoning: model.reasoning,
          image: model.input.includes("image"),
        });
      }
      return index;
    },

    providerDefaults(providerId: string) {
      const provider = registry.getProvider(providerId);
      const api = registry.getAll().find((model) => model.provider === providerId)?.api;
      return { name: provider?.name, baseUrl: provider?.baseUrl, api };
    },

    async fetchModels(providerId: string, baseUrl: string, api: ProviderApi): Promise<DiscoveredModel[]> {
      let resolved;
      try {
        // Resolves literals, $ENV references, !command values, and /login.
        resolved = await registry.getProviderAuth(providerId);
      } catch (error) {
        throw new Error(`无法解析该接入的认证信息：${errorMessage(error)}`);
      }
      const apiKey = resolved?.auth.apiKey?.trim();
      if (!apiKey) {
        throw new Error("该接入没有可用的 API Key。按 e 编辑接入填写，或用 /login 保存后再试");
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(resolved?.auth.headers ?? {})) {
        if (typeof value === "string") headers[key] = value;
      }
      return fetchModels({ baseUrl, api, apiKey, headers }, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS));
    },

    currentModelId(providerId: string): string | undefined {
      const model = ctx.model;
      return model && model.provider === providerId ? model.id : undefined;
    },

    async setModel(providerId: string, modelId: string): Promise<boolean> {
      const model: Model<Api> | undefined = registry.find(providerId, modelId);
      if (!model) return false;
      return pi.setModel(model);
    },

    notify(message: string, tone: "info" | "warning" | "error"): void {
      ctx.ui.notify(message, tone);
    },

    close,
  };
}

export default function modelManagerExtension(pi: ExtensionAPI) {
  pi.registerCommand(COMMAND, {
    description: "管理 Pi 的模型配置（models.json）",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("模型管理需要交互式终端。", "error");
        return;
      }
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        return new ModelManager(tui, theme, readModels(), createHost(pi, ctx, () => done()));
      });
    },
  });
}
