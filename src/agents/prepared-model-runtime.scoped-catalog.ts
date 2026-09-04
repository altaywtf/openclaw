import { getPreparedRuntimeAuthMaterializations } from "./auth-profiles/runtime-materializations.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { preparePublishedModelCatalogOwnerIdentity } from "./prepared-model-catalog-owner.js";
import type { PublishedModelCatalogOwnerCandidate } from "./prepared-model-catalog.types.js";
import {
  setPreparedModelFullCatalogAuth,
  setPreparedModelRuntimeAuthMaterializations,
} from "./prepared-model-runtime-auth.js";
import {
  prepareAgentCatalogSource,
  prepareWorkspaceBuildGroup,
} from "./prepared-model-runtime.facts.js";
import {
  materializePreparedModelCatalog,
  prepareFullCatalogFacts,
} from "./prepared-model-runtime.full-catalog.js";
import { resolvePreparedOAuthRefreshProviderIds } from "./prepared-model-runtime.oauth-refresh.js";
import type {
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
} from "./prepared-model-runtime.types.js";

export async function prepareScopedReadOnlyModelCatalogOwner(
  input: PreparedModelRuntimeInput,
  providerDiscoveryProviderIds: readonly string[],
  catalogMode: PreparedModelRuntimeCatalogMode,
): Promise<PublishedModelCatalogOwnerCandidate> {
  const scopedInput =
    input.readOnly && catalogMode !== "live"
      ? input
      : {
          ...input,
          ...(catalogMode === "live" ? { loadRuntimePlugins: true } : {}),
          readOnly: true,
        };
  const { agentFacts, pluginGeneration } = await prepareWorkspaceBuildGroup(
    [scopedInput],
    catalogMode,
    { providerDiscoveryProviderIds },
  );
  const agentFactsForInput = agentFacts[0];
  if (!agentFactsForInput) {
    throw new Error("scoped prepared model catalog facts are missing");
  }
  const catalogSource =
    catalogMode === "live"
      ? await prepareAgentCatalogSource(agentFactsForInput, pluginGeneration, catalogMode, false, {
          providerDiscoveryProviderIds,
        })
      : undefined;
  const { modelCatalog } = await prepareFullCatalogFacts(
    agentFactsForInput,
    pluginGeneration,
    catalogMode,
    catalogSource,
  );
  const catalog = materializePreparedModelCatalog(
    modelCatalog,
    agentFactsForInput.runtimeCapabilityModels,
  );
  const owner: PublishedModelCatalogOwnerCandidate = {
    catalogOwner: preparePublishedModelCatalogOwnerIdentity(scopedInput),
    agentId: scopedInput.agentId,
    agentDir: scopedInput.agentDir,
    workspaceDir: scopedInput.workspaceDir,
    config: scopedInput.config,
    modelCatalog: catalog,
    authStore: agentFactsForInput.authStore,
    providerAuth: agentFactsForInput.providerAuth,
    metadataSnapshot: pluginGeneration.pluginMetadataSnapshot,
    oauthRefreshProviderIds: resolvePreparedOAuthRefreshProviderIds({
      oauthProviders: agentFactsForInput.templateAuthStorage.getOAuthProviders(),
      providerRegistrations: pluginGeneration.pluginRegistry?.providers ?? [],
    }),
  };
  setPreparedModelFullCatalogAuth(catalog, {
    authStore: agentFactsForInput.authStore,
    providerAuth: agentFactsForInput.providerAuth,
  });
  setPreparedModelRuntimeAuthMaterializations(
    owner,
    getPreparedRuntimeAuthMaterializations(scopedInput.agentDir),
  );
  return owner;
}

/** Builds a request-scoped read-only catalog without executing live provider discovery. */
export async function prepareScopedReadOnlyModelCatalog(
  input: PreparedModelRuntimeInput,
  providerDiscoveryProviderIds: readonly string[],
): Promise<ModelCatalogSnapshot> {
  return (
    await prepareScopedReadOnlyModelCatalogOwner(input, providerDiscoveryProviderIds, "static")
  ).modelCatalog;
}

/** Builds a request-scoped read-only catalog with live discovery for selected providers. */
export async function prepareScopedReadOnlyLiveModelCatalog(
  input: PreparedModelRuntimeInput,
  providerDiscoveryProviderIds: readonly string[],
): Promise<ModelCatalogSnapshot> {
  return (await prepareScopedReadOnlyModelCatalogOwner(input, providerDiscoveryProviderIds, "live"))
    .modelCatalog;
}
