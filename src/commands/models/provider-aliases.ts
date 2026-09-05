/** Provider alias canonicalization for model catalog rows. */
import { createPreparedModelCatalogProviderNormalizer } from "../../agents/model-catalog-provider-normalizer.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadPluginManifestRegistryCore } from "../../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";

type ProviderAliasSource = {
  cfg: OpenClawConfig;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">;
};

/** Builds provider/ref canonicalizers from manifest model-catalog aliases. */
export function createModelCatalogProviderAliasCanonicalizer(params: ProviderAliasSource): {
  provider: (provider: string) => string;
  ref: <TRef extends { provider: string }>(ref: TRef) => TRef;
} {
  const provider = createPreparedModelCatalogProviderNormalizer(
    params.metadataSnapshot ?? {
      manifestRegistry: loadPluginManifestRegistryCore({ config: params.cfg }),
    },
  );
  return {
    provider,
    ref: (ref) => {
      const canonicalProvider = provider(ref.provider);
      return canonicalProvider === ref.provider ? ref : { ...ref, provider: canonicalProvider };
    },
  };
}

/** Canonicalizes the provider field on a model reference. */
export function canonicalizeModelCatalogProviderRef<TRef extends { provider: string }>(
  ref: TRef,
  params: ProviderAliasSource,
): TRef {
  return createModelCatalogProviderAliasCanonicalizer(params).ref(ref);
}
