/** Projects physical catalog rows into separate presentation and runtime metadata. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isCanonicalDottedDecimalIPv4, isLoopbackIpAddress } from "@openclaw/net-policy/ip";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  resolveMergedModelProviderConfig,
  resolveMergedModelProviderModels,
} from "../config/model-provider-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderModelRouteCandidate } from "../plugin-sdk/provider-model-types.js";
import {
  PREPARED_THINKING_POLICY,
  type ThinkingCatalogPolicyCarrier,
} from "../plugins/provider-thinking-catalog.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";

export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const host = normalizeLowercaseStringOrEmpty(url.hostname).replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      (isCanonicalDottedDecimalIPv4(host) && isLoopbackIpAddress(host)) ||
      host === "0.0.0.0" ||
      host === "::" ||
      host === "::1" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

type ModelCatalogRouteMatcher = (
  entry: ModelCatalogEntry,
  route: ProviderModelRouteCandidate,
) => boolean;

type ModelCatalogLogicalIdentity = { id: string; key: string };

/** Provider-owned catalog equivalence and exact physical-route matching. */
export type ModelCatalogRoutePolicy = {
  resolveIdentity(
    entry: Pick<ModelCatalogEntry, "provider" | "id">,
  ): ModelCatalogLogicalIdentity | null;
  matchesRoute: ModelCatalogRouteMatcher;
};

export type ModelCatalogRouteProjection =
  | { kind: "unmanaged" }
  | { kind: "unresolved"; policy: ModelCatalogRoutePolicy }
  | {
      kind: "selected";
      route: ProviderModelRouteCandidate;
      policy: ModelCatalogRoutePolicy;
    };

type ModelCatalogLogicalOverrides = Partial<
  Pick<
    ModelCatalogEntry,
    | "name"
    | "contextWindow"
    | "contextTokens"
    | "reasoning"
    | "configuredReasoning"
    | "thinkingLevelMap"
    | "input"
  >
>;

/** Reads explicit logical capability overrides without re-resolving auth. */
export function resolveConfiguredModelCatalogOverrides(params: {
  cfg: OpenClawConfig;
  entry: Pick<ModelCatalogEntry, "provider" | "id">;
  policy?: ModelCatalogRoutePolicy;
}): ModelCatalogLogicalOverrides | undefined {
  const provider = normalizeProviderId(params.entry.provider);
  const providerConfig = resolveMergedModelProviderConfig(params.cfg, provider);
  if (!providerConfig) {
    return undefined;
  }
  const configuredIdentity = params.policy?.resolveIdentity(params.entry);
  const normalizeConfiguredModelId = (modelId: string) =>
    params.policy?.resolveIdentity({ provider: params.entry.provider, id: modelId })?.key ??
    modelId;
  const model = resolveMergedModelProviderModels({
    models: providerConfig.models,
    normalizeModelId: normalizeConfiguredModelId,
  }).get(configuredIdentity?.key ?? params.entry.id);
  const overrides: ModelCatalogLogicalOverrides = {
    ...(model?.name ? { name: model.name } : {}),
    ...(model?.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model?.contextTokens !== undefined ? { contextTokens: model.contextTokens } : {}),
    ...(model?.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model?.reasoning !== undefined ? { configuredReasoning: model.reasoning } : {}),
    ...(model?.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    ...(model?.input !== undefined ? { input: model.input } : {}),
  };
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function logicalIdentity(
  entry: ModelCatalogEntry,
  id: string,
  name?: string,
  lifecycleEntry: ModelCatalogEntry = entry,
): ModelCatalogEntry {
  return {
    id,
    name: name ?? id,
    provider: entry.provider,
    ...(entry.alias ? { alias: entry.alias } : {}),
    ...(lifecycleEntry.providerOrder !== undefined
      ? { providerOrder: lifecycleEntry.providerOrder }
      : {}),
    ...(lifecycleEntry.status ? { status: lifecycleEntry.status } : {}),
    ...(lifecycleEntry.statusReason ? { statusReason: lifecycleEntry.statusReason } : {}),
    ...(lifecycleEntry.replaces ? { replaces: lifecycleEntry.replaces } : {}),
    ...(lifecycleEntry.replacedBy ? { replacedBy: lifecycleEntry.replacedBy } : {}),
  };
}

function applyLogicalOverrides(
  entry: ModelCatalogEntry,
  overrides: ModelCatalogLogicalOverrides | undefined,
): ModelCatalogEntry {
  return overrides ? { ...entry, ...overrides } : entry;
}

/**
 * Builds allowlisted public and private runtime projections from one donor.
 *
 * Selected-route capabilities come only from a physical row accepted by the
 * provider-owned matcher. Unresolved managed routes expose identity only.
 * Auth, runtime, request overrides, and other private transport facts never
 * enter the public catalog shape.
 */
export function projectModelCatalogEntryForRoute(params: {
  entry: ModelCatalogEntry;
  projection: ModelCatalogRouteProjection;
  catalog?: readonly ModelCatalogEntry[];
  overrides?: ModelCatalogLogicalOverrides;
}): { entry: ModelCatalogEntry; runtimeEntry: ModelCatalogEntry } {
  if (params.projection.kind === "unmanaged") {
    const entry = applyLogicalOverrides(params.entry, params.overrides);
    return { entry, runtimeEntry: entry };
  }
  const identity = params.projection.policy.resolveIdentity(params.entry);
  const id = identity?.id ?? splitTrailingAuthProfile(params.entry.id).model;
  if (params.projection.kind === "unresolved") {
    const entry = applyLogicalOverrides(
      logicalIdentity(params.entry, id, params.entry.name),
      params.overrides,
    );
    return { entry, runtimeEntry: entry };
  }

  const { policy, route } = params.projection;
  const donor: (ModelCatalogEntry & ThinkingCatalogPolicyCarrier) | undefined =
    (identity
      ? params.catalog?.find(
          (candidate) =>
            policy.resolveIdentity(candidate)?.key === identity.key &&
            policy.matchesRoute(candidate, route),
        )
      : undefined) ?? (policy.matchesRoute(params.entry, route) ? params.entry : undefined);
  const projected = logicalIdentity(
    params.entry,
    id,
    donor?.name ?? params.entry.name,
    donor ?? params.entry,
  );
  // Only the selected physical donor can supply its prepared policy owner.
  const thinkingPolicy = donor?.[PREPARED_THINKING_POLICY];
  const entry = applyLogicalOverrides(
    {
      ...projected,
      api: route.api,
      baseUrl: route.baseUrl,
      ...(donor?.contextWindow !== undefined ? { contextWindow: donor.contextWindow } : {}),
      ...(donor?.contextTokens !== undefined ? { contextTokens: donor.contextTokens } : {}),
      ...(donor?.reasoning !== undefined ? { reasoning: donor.reasoning } : {}),
      ...(donor?.thinkingLevelMap ? { thinkingLevelMap: donor.thinkingLevelMap } : {}),
      ...(donor?.thinkingPolicyProvider
        ? { thinkingPolicyProvider: donor.thinkingPolicyProvider }
        : {}),
      ...(thinkingPolicy !== undefined ? { [PREPARED_THINKING_POLICY]: thinkingPolicy } : {}),
      ...(donor?.input !== undefined ? { input: donor.input } : {}),
    },
    params.overrides,
  );
  return {
    entry,
    runtimeEntry: donor
      ? {
          ...entry,
          ...(Object.hasOwn(donor, "compat") ? { compat: donor.compat } : {}),
          ...(Object.hasOwn(donor, "params") ? { params: donor.params } : {}),
        }
      : entry,
  };
}
