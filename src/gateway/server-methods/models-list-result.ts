// Resolves public model catalogs without exposing runtime-only provider params.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type {
  ModelChoice,
  ModelsListParams,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { PreparedProviderAuth } from "../../agents/agent-auth-credential-modes.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { RuntimeAuthMaterialization } from "../../agents/auth-profiles/runtime-materializations.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { resolveConfiguredModelEntries } from "../../agents/configured-model-entries.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import type { ModelAuthAvailabilityEvaluation } from "../../agents/model-auth-availability.js";
import { buildProviderConfigModelCatalogForBrowse } from "../../agents/model-catalog-browse.js";
import { getPreparedModelCatalogDecisions } from "../../agents/model-catalog-decisions.js";
import { prepareModelCatalogView } from "../../agents/model-catalog-view.js";
import type { ModelCatalogSnapshot, ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { modelKey } from "../../agents/model-ref-shared.js";
import { resolveModelCatalogIdentityKey } from "../../agents/openai-model-routes.js";
import { publishedModelCatalogOwnerMatchesAgent } from "../../agents/prepared-model-catalog-owner.js";
import { isPreparedModelCatalogFull } from "../../agents/prepared-model-runtime.full-catalog.js";
import { getPreparedModelRuntimePublicationRevision } from "../../agents/prepared-model-runtime.publication-events.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { getRuntimeConfigSourceSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { GatewayAgentRuntime } from "../../shared/session-types.js";
import {
  loadDeferredCatalog,
  readPreparedCatalog,
  type PreparedGatewayModelCatalogSnapshot,
} from "../server-model-catalog-auth.js";
import { resolveGatewayModelThinkingProfile } from "../session-utils-model.js";
import { projectWorkerPlacementAgentRuntime } from "../worker-environments/placement-session-runtime.js";
import { resolveModelProviderCapabilities } from "./model-provider-capabilities.js";
import {
  buildPublicModelProjection,
  projectProviderCatalogOutcomes,
} from "./models-list-public-projection.js";
import type { GatewayRequestContext } from "./types.js";

type ApiKeyProviderCapabilities = {
  providers: ReadonlyMap<string, boolean>;
  resolveProvider(provider: string): string;
};
type ModelsListResult = {
  models: ModelChoice[];
  refreshFailed?: boolean;
  providerOutcomes?: ReturnType<typeof projectProviderCatalogOutcomes>;
};
type PreparedModelsListResult = {
  read: () => ModelsListResult;
  isCurrent: () => boolean;
};

/** Configured dynamic-catalog providers that omit explicit model inventory. */
function listConfiguredRuntimeDiscoveryProviderIds(
  cfg: OpenClawConfig,
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">,
): Set<string> {
  const ids = new Set<string>();
  const providers = cfg.models?.providers;
  if (!providers || typeof providers !== "object" || !metadataSnapshot) {
    return ids;
  }
  const dynamicProviders = new Set<string>();
  for (const plugin of metadataSnapshot.plugins) {
    for (const [providerRaw, mode] of Object.entries(plugin.modelCatalog?.discovery ?? {})) {
      const providerId = normalizeProviderId(providerRaw);
      if (providerId && (mode === "runtime" || mode === "refreshable")) {
        dynamicProviders.add(providerId);
      }
    }
  }
  for (const [providerRaw, provider] of Object.entries(providers)) {
    const providerId = normalizeProviderId(providerRaw);
    if (providerId && dynamicProviders.has(providerId) && !Array.isArray(provider?.models)) {
      ids.add(providerId);
    }
  }
  return ids;
}

function resolveProviderConfigInventoryEntries(params: {
  authoredEntries: readonly ModelCatalogEntry[];
  canonicalEntries: readonly ModelCatalogEntry[];
  discoveryOnlyProviderIds?: ReadonlySet<string>;
}): ModelCatalogEntry[] {
  const canonicalByKey = new Map<string, ModelCatalogEntry>();
  for (const entry of params.canonicalEntries) {
    const key = resolveModelCatalogIdentityKey(entry);
    if (!canonicalByKey.has(key)) {
      canonicalByKey.set(key, entry);
    }
  }
  const seen = new Set<string>();
  const inventory: ModelCatalogEntry[] = [];
  for (const authoredEntry of params.authoredEntries) {
    const key = resolveModelCatalogIdentityKey(authoredEntry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    // Authored config owns inventory membership. Canonical catalog rows own
    // route metadata; configured logical overrides are applied by the projector.
    inventory.push(canonicalByKey.get(key) ?? authoredEntry);
  }
  if (params.discoveryOnlyProviderIds) {
    // Providers configured without explicit model lists (for example litellm)
    // surface their key-scoped discovered rows as the configured inventory.
    for (const canonicalEntry of params.canonicalEntries) {
      const key = resolveModelCatalogIdentityKey(canonicalEntry);
      if (seen.has(key)) {
        continue;
      }
      if (!params.discoveryOnlyProviderIds.has(normalizeProviderId(canonicalEntry.provider))) {
        continue;
      }
      seen.add(key);
      inventory.push(canonicalEntry);
    }
  }
  return inventory;
}

/** Builds one per-agent, snapshot-scoped route projection for Gateway thinking metadata. */
export function createGatewayAgentModelCatalogProjector(params: {
  cfg: OpenClawConfig;
  agentId: string;
  snapshot: ModelCatalogSnapshot;
  metadataSnapshot: PluginMetadataSnapshot;
  preparedAuthStore: AuthProfileStore;
  preparedProviderAuth?: PreparedProviderAuth;
  preparedRuntimeAuthMaterializations?: readonly RuntimeAuthMaterialization[];
  preferredProfileId?: string;
  lockedProfileId?: string;
}) {
  // The Gateway owns one process-lifecycle plugin metadata snapshot. Carry it
  // through the whole projection so per-model normalization cannot rediscover it.
  const metadataSnapshot = params.metadataSnapshot;
  const workspaceDir =
    resolveAgentWorkspaceDir(params.cfg, params.agentId) ?? resolveDefaultAgentWorkspaceDir();
  const facts = {
    cfg: params.cfg,
    agentId: params.agentId,
    snapshot: params.snapshot,
    metadataSnapshot,
    auth: { authStore: params.preparedAuthStore, providerAuth: params.preparedProviderAuth ?? {} },
    authMaterializations: params.preparedRuntimeAuthMaterializations,
    workspaceDir,
  };
  const decisions = getPreparedModelCatalogDecisions(facts);
  const decisionContext = {
    preferredProfileId: params.preferredProfileId,
    lockedProfileId: params.lockedProfileId,
  };
  let projectedCatalog: Promise<ModelCatalogEntry[]> | undefined;
  return {
    decisions,
    decisionContext,
    metadataSnapshot,
    authStore: params.preparedAuthStore,
    providerAuth: facts.auth.providerAuth,
    authMaterializations: params.preparedRuntimeAuthMaterializations,
    projectCatalog: () =>
      (projectedCatalog ??= prepareModelCatalogView({
        ...facts,
        ...decisionContext,
        view: "all",
      }).then((view) => view.runtimeCatalog)),
  };
}

function createPublicModelsListProjector(params: {
  thinkingCatalog: ModelCatalogEntry[];
  cfg: OpenClawConfig;
  agentId: string;
  configuredEntriesByKey: ReturnType<typeof resolveConfiguredModelEntries>["byKey"];
  runtime: (entry: ModelCatalogEntry) => GatewayAgentRuntime | undefined;
  supportsFastMode: (entry: ModelCatalogEntry) => boolean | undefined;
  includeInput?: boolean;
  preserveUnknownAvailability?: boolean;
  apiKeyCapabilities?: ApiKeyProviderCapabilities;
}) {
  // Route rows retain identity across reads; keep display/thinking work outside the hot overlay.
  const prepared = new WeakMap<ModelCatalogEntry, ModelChoice>();
  return (entry: ModelCatalogEntry, evaluation: ModelAuthAvailabilityEvaluation): ModelChoice => {
    let preparedEntry = prepared.get(entry);
    if (!preparedEntry) {
      const configuredEntry = params.configuredEntriesByKey.get(modelKey(entry.provider, entry.id));
      const publicEntry = entry;
      const capabilityProvider = params.apiKeyCapabilities?.resolveProvider(entry.provider);
      const runtime = params.runtime(entry);
      const supportsFastMode = params.supportsFastMode(entry);
      const agentRuntime = runtime ? projectWorkerPlacementAgentRuntime(runtime) : undefined;
      const thinkingProfile =
        typeof publicEntry.reasoning !== "boolean"
          ? undefined
          : resolveGatewayModelThinkingProfile({
              cfg: params.cfg,
              agentId: params.agentId,
              provider: entry.provider,
              model: entry.id,
              agentRuntime: runtime?.id,
              modelCatalog: params.thinkingCatalog,
              configuredReasoning: publicEntry.configuredReasoning ?? publicEntry.reasoning,
              thinkingPolicyProvider: publicEntry.thinkingPolicyProvider,
            });
      const fastModeState = resolveFastModeState({
        cfg: params.cfg,
        agentId: params.agentId,
        provider: entry.provider,
        model: entry.id,
      });
      preparedEntry = {
        ...buildPublicModelProjection(publicEntry),
        ...(configuredEntry?.tags.size ? { tags: [...configuredEntry.tags] } : {}),
        ...(agentRuntime ? { agentRuntime } : {}),
        ...(supportsFastMode === undefined ? {} : { supportsFastMode }),
        ...thinkingProfile,
        ...(fastModeState.source === "default" ? {} : { effectiveFastMode: fastModeState.mode }),
        ...(capabilityProvider && params.apiKeyCapabilities?.providers.has(capabilityProvider)
          ? {
              apiKeySupported: params.apiKeyCapabilities.providers.get(capabilityProvider) === true,
            }
          : {}),
        ...(params.includeInput && entry.input?.length ? { input: entry.input } : {}),
      };
      prepared.set(entry, preparedEntry);
    }
    // Legacy views require a boolean; inventory consumers preserve unknown state.
    const projectedAvailability = params.preserveUnknownAvailability
      ? evaluation.availability
      : (evaluation.availability ?? false);
    return Object.assign(
      {},
      preparedEntry,
      projectedAvailability === undefined ? {} : { available: projectedAvailability },
      projectedAvailability === false && evaluation.unavailableReason
        ? {
            unavailableReason: evaluation.unavailableReason,
            ...(evaluation.unavailableUntil !== undefined
              ? { unavailableUntil: evaluation.unavailableUntil }
              : {}),
          }
        : {},
    );
  };
}

function apiKeyProviderCapabilities(params: {
  cfg: OpenClawConfig;
  metadataSnapshot: PluginMetadataSnapshot;
  workspaceDir: string;
}): ApiKeyProviderCapabilities {
  const { capabilities, resolveProvider } = resolveModelProviderCapabilities({
    config: params.cfg,
    metadataSnapshot: params.metadataSnapshot,
    workspaceDir: params.workspaceDir,
  });
  return {
    providers: new Map(
      capabilities.map(({ provider, apiKeySupported }) => [provider, apiKeySupported]),
    ),
    resolveProvider,
  };
}

/** Where the catalog rows come from; each caller already holds the facts it wants projected. */
export type ModelsListCatalogSource =
  | {
      kind: "gateway";
      context: Pick<GatewayRequestContext, "getRuntimeConfig" | "loadGatewayModelCatalogSnapshot">;
    }
  | {
      /** Process-published facts only: chat metadata must never wait on live discovery. */
      kind: "published";
      context: Pick<GatewayRequestContext, "getRuntimeConfig">;
      config: OpenClawConfig;
      snapshot: ModelCatalogSnapshot;
      projector: ReturnType<typeof createGatewayAgentModelCatalogProjector>;
    };

type BuildModelsListResultParams = {
  source: ModelsListCatalogSource;
  agentId?: string;
  params: ModelsListParams;
};

export async function buildModelsListResult(
  params: BuildModelsListResultParams,
): Promise<ModelsListResult> {
  return (await prepareModelsListResult(params)).read();
}

/** Prepares the public projection from one captured catalog generation. */
export async function prepareModelsListResult(
  params: BuildModelsListResultParams,
): Promise<PreparedModelsListResult> {
  const { source } = params;
  const getRuntimeConfig = source.context.getRuntimeConfig;
  const runtimeConfig = getRuntimeConfig();
  const initialConfig = source.kind === "gateway" ? runtimeConfig : source.config;
  const initialAgentId = normalizeAgentId(params.agentId ?? resolveDefaultAgentId(initialConfig));
  const view = params.params.view ?? "default";
  const preparedOnly = params.params.preparedOnly === true;
  const refresh = params.params.refresh === true;
  const requiresFullDiscovery = !preparedOnly && (refresh || view === "all");
  let snapshot: ModelCatalogSnapshot;
  let ownerSnapshot: PreparedGatewayModelCatalogSnapshot | undefined;
  if (source.kind === "published") {
    snapshot = source.snapshot;
  } else {
    // Ordinary reads take the newest published generation; full discovery or a refresh
    // goes through the deferred loader, which owns the worker round trip.
    const loaded =
      (requiresFullDiscovery
        ? undefined
        : await readPreparedCatalog(source.context, initialAgentId)) ??
      (await loadDeferredCatalog(source.context, initialAgentId, {
        readOnly: !requiresFullDiscovery,
        refreshAuth: refresh && !requiresFullDiscovery,
        ...(refresh || view === "all" ? { refreshFullCatalog: true } : {}),
      }));
    if (
      params.agentId !== undefined &&
      !publishedModelCatalogOwnerMatchesAgent(loaded, initialAgentId)
    ) {
      return { read: () => ({ models: [] }), isCurrent: () => true };
    }
    snapshot = loaded;
    ownerSnapshot = loaded;
  }
  const cfg = ownerSnapshot?.config ?? initialConfig;
  const agentId = ownerSnapshot?.agentId ?? initialAgentId;
  const workspaceDir =
    ownerSnapshot?.workspaceDir ??
    resolveAgentWorkspaceDir(cfg, agentId) ??
    resolveDefaultAgentWorkspaceDir();
  const preparedProjectionOwner =
    ownerSnapshot ?? (source.kind === "published" ? source.projector : undefined);
  if (!preparedProjectionOwner) {
    throw new Error("Gateway model catalog omitted its prepared owner");
  }
  const { metadataSnapshot, authStore: preparedAuthStore } = preparedProjectionOwner;
  const catalog = snapshot.entries;
  const publicationRevision = getPreparedModelRuntimePublicationRevision();
  // Track Gateway turnover, not the identity of an equal config clone held by the catalog.
  const isCurrent = () =>
    getRuntimeConfig() === runtimeConfig &&
    getPreparedModelRuntimePublicationRevision() === publicationRevision &&
    (source.kind !== "published" || source.projector.decisions.isCurrent());
  const { providerOutcomes } = snapshot;
  const publicProviderOutcomes = projectProviderCatalogOutcomes(providerOutcomes);
  const outcomeProjection = {
    ...(publicProviderOutcomes?.length ? { providerOutcomes: publicProviderOutcomes } : {}),
    ...(snapshot.refreshFailed ? { refreshFailed: true } : {}),
  };
  const preparedProviderAuth = preparedProjectionOwner?.providerAuth;
  const preparedRuntimeAuthMaterializations = preparedProjectionOwner?.authMaterializations;
  // A complete catalog and its synthetic-auth probe results cross the worker boundary together.
  // Only that paired generation may turn an absent synthetic credential into missing-auth.
  const preparedSyntheticAuthComplete =
    ownerSnapshot?.catalogComplete ?? isPreparedModelCatalogFull(snapshot);
  const includeProviderCapabilities = params.params.includeProviderCapabilities === true;
  const capableProviders = includeProviderCapabilities
    ? apiKeyProviderCapabilities({ cfg, metadataSnapshot, workspaceDir })
    : undefined;
  if (view === "provider-config") {
    const sourceConfig = getRuntimeConfigSourceSnapshot() ?? cfg;
    const authoredEntries = buildProviderConfigModelCatalogForBrowse({
      cfg: sourceConfig,
      workspaceDir,
    });
    const inventoryEntries = resolveProviderConfigInventoryEntries({
      authoredEntries,
      canonicalEntries: catalog,
      discoveryOnlyProviderIds: listConfiguredRuntimeDiscoveryProviderIds(
        sourceConfig,
        metadataSnapshot,
      ),
    });
    const inventory = await prepareModelCatalogView({
      cfg,
      agentId,
      workspaceDir,
      snapshot,
      inventoryEntries,
      metadataSnapshot,
      auth: { authStore: preparedAuthStore, providerAuth: preparedProviderAuth ?? {} },
      authMaterializations: preparedRuntimeAuthMaterializations,
      catalogComplete: preparedSyntheticAuthComplete,
      view: "all",
      ...(source.kind === "published" ? source.projector.decisionContext : {}),
    });
    const projectPublic = createPublicModelsListProjector({
      thinkingCatalog: inventory.runtimeCatalog,
      cfg,
      agentId,
      configuredEntriesByKey: inventory.configuredEntries.byKey,
      runtime: inventory.runtime,
      supportsFastMode: inventory.supportsFastMode,
      includeInput: true,
      preserveUnknownAvailability: true,
      ...(capableProviders ? { apiKeyCapabilities: capableProviders } : {}),
    });
    return {
      isCurrent: () => isCurrent() && inventory.isCurrent(),
      read: () => ({
        models: inventory.entries.map((entry) => projectPublic(entry, inventory.evaluate(entry))),
        ...outcomeProjection,
      }),
    };
  }
  const preparedView = await prepareModelCatalogView({
    cfg,
    agentId,
    workspaceDir,
    snapshot,
    metadataSnapshot,
    auth: { authStore: preparedAuthStore, providerAuth: preparedProviderAuth ?? {} },
    authMaterializations: preparedRuntimeAuthMaterializations,
    catalogComplete: preparedSyntheticAuthComplete,
    view,
    ...(source.kind === "published" ? source.projector.decisionContext : {}),
  });
  const projectPublic = createPublicModelsListProjector({
    thinkingCatalog: preparedView.runtimeCatalog,
    cfg,
    agentId,
    configuredEntriesByKey: preparedView.configuredEntries.byKey,
    runtime: preparedView.runtime,
    supportsFastMode: preparedView.supportsFastMode,
    ...(capableProviders ? { apiKeyCapabilities: capableProviders } : {}),
  });
  const models = preparedView.entries.map((entry) =>
    projectPublic(entry, preparedView.evaluate(entry)),
  );
  return {
    isCurrent: () => isCurrent() && preparedView.isCurrent(),
    read: () => ({ models, ...outcomeProjection }),
  };
}
