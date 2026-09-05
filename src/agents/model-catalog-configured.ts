import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  createModelVisibilityPolicy,
  RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
} from "./model-visibility-policy.js";
import { resolveModelCatalogIdentityKey } from "./openai-model-routes.js";

export function mergeStaticModelCatalogEntries(params: {
  cfg: OpenClawConfig;
  agentId: string;
  snapshot: ModelCatalogSnapshot;
  defaultModel?: string;
  metadataSnapshot: PluginMetadataSnapshot;
  view: "configured" | "all";
}): ModelCatalogEntry[] {
  const catalog = [...params.snapshot.entries];
  if (!params.snapshot.staticEntries?.length) {
    return catalog;
  }
  const configuredKeys = new Set<string>();
  if (params.view === "configured") {
    const policy = createModelVisibilityPolicy({
      cfg: params.cfg,
      catalog,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: params.defaultModel,
      agentId: params.agentId,
      ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
      manifestPlugins: params.metadataSnapshot,
    });
    for (const key of policy.configuredKeys) {
      const separator = key.indexOf("/");
      configuredKeys.add(
        separator > 0
          ? resolveModelCatalogIdentityKey({
              provider: key.slice(0, separator),
              id: key.slice(separator + 1),
            })
          : key,
      );
    }
  }
  const seen = new Set(catalog.map(resolveModelCatalogIdentityKey));
  for (const entry of params.snapshot.staticEntries) {
    const key = resolveModelCatalogIdentityKey(entry);
    if (!seen.has(key) && (params.view === "all" || configuredKeys.has(key))) {
      seen.add(key);
      catalog.push(entry);
    }
  }
  return catalog;
}
