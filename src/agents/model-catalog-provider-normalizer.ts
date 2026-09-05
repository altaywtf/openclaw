import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

/** Prepares provider aliases once for one captured catalog metadata generation. */
export function createPreparedModelCatalogProviderNormalizer(
  metadataSnapshot: Pick<PluginMetadataSnapshot, "manifestRegistry">,
): (provider: string) => string {
  let aliases: Map<string, string> | undefined;
  return (provider) => {
    const normalizedProvider = normalizeProviderId(provider);
    if (!aliases) {
      aliases = new Map();
      for (const plugin of metadataSnapshot.manifestRegistry.plugins) {
        for (const [alias, target] of Object.entries(plugin.modelCatalog?.aliases ?? {})) {
          const key = normalizeProviderId(alias);
          const canonicalProvider = normalizeProviderId(target.provider);
          // Duplicate aliases retain the first nonempty target in manifest order.
          if (canonicalProvider && !aliases.has(key)) {
            aliases.set(key, canonicalProvider);
          }
        }
      }
    }
    return aliases.get(normalizedProvider) ?? normalizedProvider;
  };
}
