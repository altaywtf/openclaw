import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginMetadataSnapshotCache, withPluginCache } from "../plugins/plugin-cache.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { ProviderPolicySurface } from "../plugins/provider-policy-surface.js";
import { resolveProviderPolicySurface } from "../plugins/provider-public-artifacts.js";
import type { GatewayAgentRuntime } from "../shared/session-types.js";
import { isDefaultAgentRuntimeId } from "./agent-runtime-id.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { resolveModelExtraParamSources } from "./model-extra-params.js";
import { resolveProviderModelRouteAuthRequirement } from "./provider-model-route-auth.js";
import { resolveProviderRequestPolicyConfig } from "./provider-request-config.js";

export function createModelCatalogFastModeResolver(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entries: readonly ModelCatalogEntry[];
  metadataSnapshot: PluginMetadataSnapshot;
}): (selection: {
  entry: ModelCatalogEntry;
  evaluation: ModelAuthAvailabilityEvaluation;
  runtime: GatewayAgentRuntime | undefined;
}) => boolean | undefined {
  const cache = getPluginMetadataSnapshotCache(params.metadataSnapshot);
  const hooks = withPluginCache(cache, () => {
    const captured = new Map<string, ProviderPolicySurface["resolveFastModeCapability"]>();
    for (const provider of new Set(params.entries.map((entry) => entry.provider))) {
      captured.set(
        provider,
        resolveProviderPolicySurface(provider, {
          manifestRegistry: params.metadataSnapshot.manifestRegistry,
        })?.resolveFastModeCapability,
      );
    }
    return captured;
  });

  return ({ entry, evaluation, runtime }) => {
    const hook = hooks.get(entry.provider);
    if (!hook || isDefaultAgentRuntimeId(runtime?.id)) {
      return undefined;
    }
    const route = evaluation.selectedRoute;
    if (evaluation.routeResolution !== null && !route) {
      return undefined;
    }
    return withPluginCache(cache, () => {
      const api = route?.api ?? entry.api;
      const baseUrl = route?.baseUrl ?? entry.baseUrl;
      const endpointClass = baseUrl
        ? resolveProviderRequestPolicyConfig({
            provider: entry.provider,
            modelId: entry.id,
            api,
            baseUrl,
            compat: entry.compat,
            providerMetadataOwners: params.metadataSnapshot.owners,
            capability: "llm",
            transport: "stream",
          }).capabilities.endpointClass
        : undefined;
      const { defaultParams, modelParams, agentParams } = resolveModelExtraParamSources({
        config: params.cfg,
        provider: entry.provider,
        modelId: entry.id,
        agentId: params.agentId,
      });
      return (
        hook({
          provider: entry.provider,
          modelId: entry.id,
          api,
          baseUrl,
          endpointClass,
          agentRuntime: runtime?.id,
          authRequirement:
            route?.authRequirement ??
            resolveProviderModelRouteAuthRequirement(evaluation.selectedAuthMode),
          requestTransportOverrides: route?.requestTransportOverrides,
          params:
            entry.params || defaultParams || modelParams || agentParams
              ? { ...entry.params, ...defaultParams, ...modelParams, ...agentParams }
              : undefined,
        }) ?? undefined
      );
    });
  };
}
