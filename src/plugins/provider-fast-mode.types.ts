import type {
  ProviderModelRouteAuthRequirement,
  ProviderRouteOverridePresence,
} from "../plugin-sdk/provider-model-types.js";

export type ProviderFastModeCapabilityContext = {
  provider: string;
  modelId: string;
  api?: string;
  baseUrl?: string;
  endpointClass?: string;
  agentRuntime?: string;
  authRequirement?: ProviderModelRouteAuthRequirement;
  requestTransportOverrides?: ProviderRouteOverridePresence;
  params?: Record<string, unknown>;
};
