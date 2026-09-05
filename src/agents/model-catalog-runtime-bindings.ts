import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { resolvePluginSetupRegistry } from "../plugins/setup-registry.js";
import type { ModelCatalogRuntimeBinding } from "./model-catalog.types.js";

export function prepareModelCatalogRuntimeBindings(params: {
  config: OpenClawConfig;
  metadataSnapshot: PluginMetadataSnapshot;
  pluginRegistry?: PluginRegistry;
  env: NodeJS.ProcessEnv;
}): readonly ModelCatalogRuntimeBinding[] {
  const bindings = new Map<string, ModelCatalogRuntimeBinding>();
  const registered = params.pluginRegistry?.cliBackends ?? [];
  const registeredOwners = new Set(registered.map((entry) => entry.pluginId));
  const plugins = params.metadataSnapshot.plugins.filter((plugin) =>
    isManifestPluginAvailableForControlPlane({
      snapshot: params.metadataSnapshot,
      plugin,
      config: params.config,
    }),
  );
  const setupOwnerIds = plugins
    .filter(
      (plugin) =>
        !registeredOwners.has(plugin.id) &&
        (plugin.cliBackends.length > 0 || (plugin.setup?.cliBackends?.length ?? 0) > 0),
    )
    .map((plugin) => plugin.id);
  const setupBackends =
    setupOwnerIds.length > 0
      ? resolvePluginSetupRegistry({
          config: params.config,
          env: params.env,
          workspaceDir: params.metadataSnapshot.workspaceDir,
          manifestRegistry: params.metadataSnapshot.manifestRegistry,
          pluginIds: setupOwnerIds,
        }).cliBackends
      : [];
  for (const { backend } of [...registered, ...setupBackends]) {
    if (!backend.modelProvider?.trim()) {
      continue;
    }
    const provider = normalizeProviderId(backend.modelProvider);
    const runtime = normalizeProviderId(backend.id);
    if (provider && runtime) {
      bindings.set(`${provider}\0${runtime}`, Object.freeze({ provider, runtime }));
    }
  }
  return Object.freeze(
    [...bindings.values()].toSorted(
      (left, right) =>
        left.provider.localeCompare(right.provider) || left.runtime.localeCompare(right.runtime),
    ),
  );
}
