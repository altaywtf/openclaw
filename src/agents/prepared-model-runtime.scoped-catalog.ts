import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  prepareAgentCatalogSource,
  prepareWorkspaceBuildGroup,
} from "./prepared-model-runtime.facts.js";
import {
  materializePreparedModelCatalog,
  prepareFullCatalogFacts,
} from "./prepared-model-runtime.full-catalog.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

export async function prepareScopedReadOnlyLiveModelCatalog(
  input: PreparedModelRuntimeInput,
  providerDiscoveryProviderIds: readonly string[],
): Promise<ModelCatalogSnapshot> {
  const scopedInput = { ...input, loadRuntimePlugins: true, readOnly: true };
  const { agentFacts, pluginGeneration } = await prepareWorkspaceBuildGroup([scopedInput], "live", {
    providerDiscoveryProviderIds,
  });
  const agentFactsForInput = agentFacts[0];
  if (!agentFactsForInput) {
    throw new Error("scoped prepared model catalog facts are missing");
  }
  const catalogSource = await prepareAgentCatalogSource(
    agentFactsForInput,
    pluginGeneration,
    "live",
    false,
    { providerDiscoveryProviderIds },
  );
  const { modelCatalog } = await prepareFullCatalogFacts(
    agentFactsForInput,
    pluginGeneration,
    catalogSource,
  );
  return materializePreparedModelCatalog(modelCatalog, agentFactsForInput.runtimeCapabilityModels);
}
