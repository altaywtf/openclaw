import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveOwningPluginIdsForProviderRef } from "../plugins/providers.js";
import type { GatewayAgentRuntime } from "../shared/session-types.js";
import { resolveAgentEffectiveModelPrimary } from "./agent-scope.js";
import { resolveConfiguredModelEntries } from "./configured-model-entries.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import { createModelCatalogFastModeResolver } from "./model-catalog-capabilities.js";
import { mergeStaticModelCatalogEntries } from "./model-catalog-configured.js";
import {
  getPreparedModelCatalogDecisions,
  type ModelCatalogDecisionContext,
  type ModelCatalogDecisionFacts,
} from "./model-catalog-decisions.js";
import { findModelCatalogRouteDonor } from "./model-catalog-route.js";
import {
  prepareLogicalVisibleModelCatalog,
  resolveLogicalModelCatalogEntryState,
} from "./model-catalog-visibility.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createModelPickerVisibleProviderPredicate } from "./model-runtime-aliases.js";
import { resolveDefaultModelForAgent } from "./model-selection-config.js";
import {
  createModelVisibilityPolicy,
  RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
} from "./model-visibility-policy.js";
import {
  openAIModelCatalogRoutePolicy,
  resolveModelCatalogIdentityKey,
} from "./openai-model-routes.js";
import type { LoadPreparedModelCatalogParams } from "./prepared-model-catalog.js";
import { getPreparedModelRuntimeAuthMaterializations } from "./prepared-model-runtime-auth.js";

export type ModelCatalogViewParams = ModelCatalogDecisionFacts &
  ModelCatalogDecisionContext & {
    view?: "default" | "configured" | "all";
    inventoryEntries?: readonly ModelCatalogEntry[];
  };

function preparedAuthLabel(evaluation: ModelAuthAvailabilityEvaluation): string | undefined {
  if (evaluation.availability !== true) {
    return undefined;
  }
  if (evaluation.runtimeAuth?.source === "native") {
    return "native sign-in";
  }
  switch (evaluation.selectedAuthMode) {
    case "api_key":
    case "api-key":
      return "API key";
    case "oauth":
      return "account sign-in";
    case "token":
      return "token";
    case "aws-sdk":
      return "AWS credentials";
    default:
      return undefined;
  }
}

export async function prepareModelCatalogView(params: ModelCatalogViewParams) {
  const view = params.view === "all" ? "all" : "configured";
  const defaultModel = resolveAgentEffectiveModelPrimary(params.cfg, params.agentId);
  const isVisibleProvider = createModelPickerVisibleProviderPredicate({
    runtimeBindings: params.snapshot.runtimeBindings ?? [],
  });
  const catalog = (
    params.inventoryEntries ??
    mergeStaticModelCatalogEntries({
      ...params,
      defaultModel,
      view,
    })
  ).filter((entry) => isVisibleProvider(entry.provider));
  const decisions = getPreparedModelCatalogDecisions(params);
  const routeVariants = catalog.flatMap((entry) => decisions.variants(entry));
  const policy = createModelVisibilityPolicy({
    cfg: params.cfg,
    catalog,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel,
    agentId: params.agentId,
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    manifestPlugins: params.metadataSnapshot,
  });
  const evaluations = new Map<string, ModelAuthAvailabilityEvaluation>();
  const readCatalog = await prepareLogicalVisibleModelCatalog({
    cfg: params.cfg,
    catalog,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    view,
    policy,
    routePolicy: openAIModelCatalogRoutePolicy,
    routeVariants,
    prepareEntry: async (entry) => {
      const evaluation = await decisions.evaluate(entry, params);
      evaluations.set(resolveModelCatalogIdentityKey(entry), evaluation);
      const syntheticLocal =
        evaluation.routeResolution === null &&
        normalizeProviderId(entry.provider) !== "openai" &&
        evaluation.availability === undefined &&
        evaluation.evidence === "synthetic";
      const state = resolveLogicalModelCatalogEntryState({
        evaluation,
        authBacked: evaluation.availability === true || syntheticLocal,
        routePolicy: openAIModelCatalogRoutePolicy,
      });
      return () => state;
    },
  });
  const configuredEntries = resolveConfiguredModelEntries({
    cfg: params.cfg,
    catalog,
    agentId: params.agentId,
    defaultModel,
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    manifestPlugins: params.metadataSnapshot,
  });
  const runtimes = new Map<string, GatewayAgentRuntime | undefined>();
  const runtimeChoices = new Map<string, readonly string[]>();
  const labelsByProvider = new Map<string, Set<string | undefined>>();
  const entries = readCatalog().map((entry) => {
    const configured = configuredEntries.byKey.get(`${entry.provider}/${entry.id}`);
    const alias = configured?.aliasDisabled
      ? undefined
      : (configured?.aliases.at(-1) ?? entry.alias);
    return alias === entry.alias ? entry : Object.assign({}, entry, { alias });
  });
  const runtimeCatalog = entries.map((entry) => {
    const route = evaluations.get(resolveModelCatalogIdentityKey(entry))?.selectedRoute;
    const donor = route
      ? findModelCatalogRouteDonor({
          entry,
          route,
          policy: openAIModelCatalogRoutePolicy,
          catalog: decisions.variants(entry),
        })
      : undefined;
    return donor
      ? {
          ...entry,
          ...(Object.hasOwn(donor, "compat") ? { compat: donor.compat } : {}),
          ...(Object.hasOwn(donor, "params") ? { params: donor.params } : {}),
        }
      : entry;
  });
  const resolveFastMode = createModelCatalogFastModeResolver({
    cfg: params.cfg,
    agentId: params.agentId,
    metadataSnapshot: params.metadataSnapshot,
    entries: runtimeCatalog,
  });
  const fastModes = new Map<string, boolean | undefined>();
  const providerOwners = new Map<string, readonly string[]>();
  const ownersForProvider = (provider: string) => {
    let owners = providerOwners.get(provider);
    if (!owners) {
      owners =
        resolveOwningPluginIdsForProviderRef({
          provider,
          metadataSnapshot: params.metadataSnapshot,
        }) ?? [];
      providerOwners.set(provider, owners);
    }
    return owners;
  };
  for (const entry of runtimeCatalog) {
    const key = resolveModelCatalogIdentityKey(entry);
    const evaluation = evaluations.get(key)!;
    const runtime = await decisions.runtime(entry, params);
    const labels = labelsByProvider.get(entry.provider) ?? new Set<string | undefined>();
    labels.add(preparedAuthLabel(evaluation));
    labelsByProvider.set(entry.provider, labels);
    runtimes.set(key, runtime);
    runtimeChoices.set(key, await decisions.runtimeChoices(entry, params));
    fastModes.set(key, resolveFastMode({ entry, evaluation, runtime }));
  }
  return {
    isCurrent: decisions.isCurrent,
    matchesProvider(provider: string, requested: string) {
      const normalized = normalizeProviderId(provider);
      const target = normalizeProviderId(requested);
      return (
        normalized === target ||
        ownersForProvider(normalized).some((owner) => ownersForProvider(target).includes(owner))
      );
    },
    catalog,
    entries,
    runtimeCatalog,
    defaultModel,
    resolvedDefault: resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
      ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
      manifestPlugins: params.metadataSnapshot,
    }),
    metadataSnapshot: params.metadataSnapshot,
    configuredEntries,
    refreshFailed: params.snapshot.refreshFailed,
    providerAuthLabels: new Map(
      [...labelsByProvider].flatMap(([provider, labels]) => {
        const label = labels.values().next().value;
        return labels.size === 1 && label ? [[provider, label] as const] : [];
      }),
    ),
    runtime: (entry: ModelCatalogEntry) => runtimes.get(resolveModelCatalogIdentityKey(entry)),
    runtimeChoices: (entry: ModelCatalogEntry) =>
      runtimeChoices.get(resolveModelCatalogIdentityKey(entry)) ?? [],
    supportsFastMode: (entry: ModelCatalogEntry) =>
      fastModes.get(resolveModelCatalogIdentityKey(entry)),
    evaluate(entry: ModelCatalogEntry) {
      const evaluation = evaluations.get(resolveModelCatalogIdentityKey(entry));
      if (!evaluation) {
        throw new Error("Model catalog view omitted prepared auth evaluation");
      }
      return evaluation;
    },
  };
}

export async function loadPreparedModelCatalogView(
  params: LoadPreparedModelCatalogParams &
    Pick<
      ModelCatalogViewParams,
      "view" | "profileProvider" | "preferredProfileId" | "lockedProfileId" | "runtimeOverride"
    > = {},
) {
  const { loadResolvedPublishedModelCatalogOwner } = await import("./prepared-model-catalog.js");
  const owner = await loadResolvedPublishedModelCatalogOwner({
    ...params,
    readOnly: params.readOnly ?? true,
  });
  return prepareModelCatalogView({
    cfg: owner.config,
    agentId: owner.agentId,
    workspaceDir: owner.workspaceDir,
    snapshot: owner.modelCatalog,
    metadataSnapshot: owner.metadataSnapshot,
    auth: { authStore: owner.authStore, providerAuth: owner.providerAuth },
    authMaterializations: getPreparedModelRuntimeAuthMaterializations(owner),
    view: params.view,
    profileProvider: params.profileProvider,
    preferredProfileId: params.preferredProfileId,
    lockedProfileId: params.lockedProfileId,
    runtimeOverride: params.runtimeOverride,
    env: params.env,
  });
}
