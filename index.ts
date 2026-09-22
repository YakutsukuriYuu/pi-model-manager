import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectCatalog, type CatalogSnapshot } from "./src/catalog.ts";
import {
  createManagedProvider,
  loadManagedProviders,
  managedProviderIds,
  saveManagedProviders,
  SUPPORTED_APIS,
  upsertManagedProvider,
  type ManagedApi,
  type ManagedProviderConfig,
} from "./src/managed-providers.ts";
import { ModelManager } from "./src/ui.ts";

const COMMAND = "models";

function currentModelKey(ctx: ExtensionContext): string | undefined {
  const model = ctx.model;
  return model ? `${model.provider}/${model.id}` : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function refreshCatalog(ctx: ExtensionContext, managedIds: ReadonlySet<string>): Promise<CatalogSnapshot> {
  const result = await ctx.modelRegistry.refresh({ force: true });
  const errors = [...result.errors.entries()];
  if (errors.length > 0) {
    const summary = errors.map(([provider, error]) => `${provider}: ${errorMessage(error)}`).join("; ");
    ctx.ui.notify(`部分 Provider 刷新失败：${summary}`, "warning");
  }
  return collectCatalog(ctx.modelRegistry, managedIds);
}

function normalizedProviderId(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return slug.startsWith("pi-auto-") ? slug : `pi-auto-${slug || "provider"}`;
}

async function addManagedProvider(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configs: ManagedProviderConfig[],
  managedIds: Set<string>,
): Promise<void> {
  const name = (await ctx.ui.input("Provider name", "My company API"))?.trim();
  if (!name) return;
  const baseUrl = (await ctx.ui.input("Base URL", "https://api.example.com/v1"))?.trim();
  if (!baseUrl) return;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Base URL must use http or https");
    }
  } catch (error) {
    ctx.ui.notify(`Base URL 无效：${errorMessage(error)}`, "error");
    return;
  }
  const api = await ctx.ui.select("API type", [...SUPPORTED_APIS]);
  if (!api) return;
  const id = normalizedProviderId(name);
  if (ctx.modelRegistry.getProvider(id)) {
    ctx.ui.notify(`Provider ID ${id} 已存在，请换一个名称。`, "error");
    return;
  }

  const config: ManagedProviderConfig = { id, name, baseUrl, api: api as ManagedApi };
  const next = upsertManagedProvider(configs, config);
  saveManagedProviders(next);
  configs.splice(0, configs.length, ...next);
  managedIds.add(id);
  pi.registerProvider(createManagedProvider(config));
  ctx.ui.notify(`已添加 ${name}。请执行 /login ${id} 保存 API key，然后回到 /models 刷新。`, "info");
}

export default function modelManagerExtension(pi: ExtensionAPI) {
  const managedConfigs = loadManagedProviders();
  const managedIds = managedProviderIds(managedConfigs);
  for (const config of managedConfigs) pi.registerProvider(createManagedProvider(config));

  pi.registerCommand(COMMAND, {
    description: "打开统一模型管理器（/models add 添加 Provider）",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("模型管理器需要交互式终端。", "error");
        return;
      }
      if (args.trim().toLowerCase() === "add") {
        await addManagedProvider(pi, ctx, managedConfigs, managedIds);
        return;
      }

      let action: "close" | "add" = "close";
      do {
        action = await ctx.ui.custom<"close" | "add">((tui, theme, _keybindings, done) => {
          const snapshot = collectCatalog(ctx.modelRegistry, managedIds);
          return new ModelManager(tui, theme, snapshot, currentModelKey(ctx), {
            onSelect: (model: Model<Api>) => {
              void (async () => {
                const selected = await pi.setModel(model);
                if (!selected) {
                  ctx.ui.notify(`无法选择 ${model.provider}/${model.id}：Provider 未配置认证。`, "error");
                  return;
                }
                ctx.ui.notify(`已切换到 ${model.provider}/${model.id}`, "info");
                done("close");
              })().catch((error: unknown) => {
                ctx.ui.notify(errorMessage(error), "error");
              });
            },
            onRefresh: () => refreshCatalog(ctx, managedIds),
            onAdd: () => done("add"),
            onClose: () => done("close"),
          });
        });
        if (action === "add") await addManagedProvider(pi, ctx, managedConfigs, managedIds);
      } while (action === "add");
    },
  });
}
