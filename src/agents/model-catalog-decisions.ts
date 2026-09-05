import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { cloneConfigWithResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  PREPARED_THINKING_POLICY,
  type ThinkingCatalogPolicyCarrier,
} from "../plugins/provider-thinking-catalog.js";
import type { GatewayAgentRuntime } from "../shared/session-types.js";
import { normalizeOptionalAgentRuntimeId, OPENCLAW_AGENT_RUNTIME_ID } from "./agent-runtime-id.js";
import { cloneAuthProfileStore } from "./auth-profiles/clone.js";
import type { RuntimeAuthMaterialization } from "./auth-profiles/runtime-materializations.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { resolveConfiguredAgentHarnessPolicy } from "./harness/policy.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import { createModelCatalogAuthResolver, evaluateModelCatalogEntry } from "./model-catalog-auth.js";
import { createPreparedModelCatalogProviderNormalizer } from "./model-catalog-provider-normalizer.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
import { resolveModelCatalogIdentityKey } from "./openai-model-routes.js";
import type { PreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
import { isPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
import { getPreparedModelRuntimePublicationRevision } from "./prepared-model-runtime.publication-events.js";

export type ModelCatalogDecisionFacts = {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  snapshot: ModelCatalogSnapshot;
  metadataSnapshot: PluginMetadataSnapshot;
  auth: PreparedModelRuntimeAuth;
  authMaterializations?: readonly RuntimeAuthMaterialization[];
  catalogComplete?: boolean;
  env?: NodeJS.ProcessEnv;
};

export type ModelCatalogDecisionContext = {
  purpose?: "agent" | "utility" | "image";
  profileProvider?: string;
  preferredProfileId?: string;
  lockedProfileId?: string;
  runtimeOverride?: GatewayAgentRuntime;
};

export type PreparedModelCatalogDecisions = {
  variants(entry: Pick<ModelCatalogEntry, "provider" | "id">): readonly ModelCatalogEntry[];
  evaluate(
    entry: ModelCatalogEntry,
    context?: ModelCatalogDecisionContext,
  ): Promise<ModelAuthAvailabilityEvaluation>;
  runtime(
    entry: ModelCatalogEntry,
    context?: ModelCatalogDecisionContext,
  ): Promise<GatewayAgentRuntime | undefined>;
  runtimeChoices(
    entry: ModelCatalogEntry,
    context?: ModelCatalogDecisionContext,
  ): Promise<readonly string[]>;
  isCurrent(): boolean;
};

type CachedDecisionSource = {
  identity: readonly unknown[];
  source: PreparedModelCatalogDecisions;
};

let cachedPublicationRevision = -1;
let sourcesByStore = new WeakMap<AuthProfileStore, CachedDecisionSource[]>();
const EMPTY_CATALOG_ROWS: readonly ModelCatalogEntry[] = Object.freeze([]);

function freezeCapturedFacts<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) {
      freezeCapturedFacts(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function captureCatalogRow(
  entry: ModelCatalogEntry & ThinkingCatalogPolicyCarrier,
): ModelCatalogEntry {
  const { [PREPARED_THINKING_POLICY]: thinkingPolicy, ...data } = entry;
  return freezeCapturedFacts({
    ...structuredClone(data),
    ...(thinkingPolicy !== undefined ? { [PREPARED_THINKING_POLICY]: thinkingPolicy } : {}),
  });
}

function createDecisionSource(
  params: ModelCatalogDecisionFacts,
  revision: number,
  catalogComplete: boolean,
): PreparedModelCatalogDecisions {
  const now = Date.now();
  const { agentId, workspaceDir, metadataSnapshot } = params;
  const normalizeCatalogProvider = createPreparedModelCatalogProviderNormalizer(metadataSnapshot);
  const cfg = freezeCapturedFacts(cloneConfigWithResolutionFacts(params.cfg));
  const authStore = freezeCapturedFacts(cloneAuthProfileStore(params.auth.authStore));
  const deadlines = [
    ...Object.values(authStore.profiles).map((profile) =>
      profile.type === "api_key" ? undefined : profile.expires,
    ),
    ...Object.values(authStore.usageStats ?? {}).flatMap((stats) => [
      stats.cooldownUntil,
      stats.blockedUntil,
      stats.disabledUntil,
    ]),
  ].filter((deadline): deadline is number => deadline !== undefined && deadline > now);
  // Time can change auth readiness without a publication; the next read replaces this source.
  const validUntil = Math.min(...deadlines);
  const providerAuth = freezeCapturedFacts(structuredClone(params.auth.providerAuth));
  const runtimeBindings = freezeCapturedFacts(
    structuredClone(params.snapshot.runtimeBindings ?? []),
  );
  const authMaterializations = freezeCapturedFacts(
    structuredClone(params.authMaterializations ?? []),
  );
  const providerOutcomes = freezeCapturedFacts(structuredClone(params.snapshot.providerOutcomes));
  const env = Object.freeze({ ...(params.env ?? process.env) });
  const canonicalRows = new Map<string, ModelCatalogEntry>();
  const routeGroups = new Map<string, readonly ModelCatalogEntry[]>();
  const configuredRows = buildConfiguredModelCatalog({
    cfg,
    catalog: params.snapshot.entries,
    workspaceDir,
    manifestPlugins: metadataSnapshot,
  });
  const publishedOrConfiguredKeys = new Set(
    [...params.snapshot.entries, ...configuredRows].map(resolveModelCatalogIdentityKey),
  );
  const liveCatalogProviders = new Set(
    metadataSnapshot.plugins.flatMap((plugin) =>
      Object.entries(plugin.modelCatalog?.discovery ?? {}).flatMap(([provider, mode]) =>
        mode === "runtime" || mode === "refreshable" ? [normalizeProviderId(provider)] : [],
      ),
    ),
  );
  const capturedRows = new Map<ModelCatalogEntry, ModelCatalogEntry>();
  const capture = (row: ModelCatalogEntry) => {
    let captured = capturedRows.get(row);
    if (!captured) {
      captured = captureCatalogRow(row);
      capturedRows.set(row, captured);
    }
    return captured;
  };
  const tiers = [
    params.snapshot.routeVariants,
    params.snapshot.entries,
    configuredRows,
    params.snapshot.staticEntries ?? EMPTY_CATALOG_ROWS,
  ];
  for (const row of [...params.snapshot.entries, ...tiers.flat()]) {
    const captured = capture(row);
    const key = resolveModelCatalogIdentityKey(captured);
    if (!canonicalRows.has(key)) {
      canonicalRows.set(key, captured);
    }
  }
  for (const tier of tiers) {
    const groups = new Map<string, ModelCatalogEntry[]>();
    for (const row of new Set(tier)) {
      const captured = capture(row);
      const key = resolveModelCatalogIdentityKey(captured);
      const group = groups.get(key) ?? [];
      group.push(captured);
      groups.set(key, group);
    }
    for (const [key, group] of groups) {
      if (!routeGroups.has(key)) {
        routeGroups.set(key, Object.freeze(group));
      }
    }
  }
  const authParams = {
    cfg,
    agentId,
    workspaceDir,
    metadataSnapshot,
    preparedAuthStore: authStore,
    preparedSyntheticAuthComplete: catalogComplete,
    env,
    now,
  };
  const authResolver = createModelCatalogAuthResolver({
    ...authParams,
    preparedProviderAuth: providerAuth,
    preparedRuntimeAuthMaterializations: authMaterializations,
  });
  const directAuthResolver = createModelCatalogAuthResolver({
    ...authParams,
    preparedProviderAuth: freezeCapturedFacts(
      Object.fromEntries(
        Object.entries(providerAuth).filter(([, auth]) => auth.runtime === undefined),
      ),
    ),
    preparedRuntimeAuthMaterializations: [],
  });
  const evaluations = new Map<string, Promise<ModelAuthAvailabilityEvaluation>>();
  const resolveOwnedEntry = (entry: ModelCatalogEntry): ModelCatalogEntry =>
    canonicalRows.get(resolveModelCatalogIdentityKey(entry)) ?? {
      provider: entry.provider,
      id: entry.id,
      name: entry.id,
    };
  const source: PreparedModelCatalogDecisions = Object.freeze({
    variants: (entry: Pick<ModelCatalogEntry, "provider" | "id">) =>
      routeGroups.get(resolveModelCatalogIdentityKey(entry)) ?? EMPTY_CATALOG_ROWS,
    evaluate(entry: ModelCatalogEntry, context: ModelCatalogDecisionContext = {}) {
      const purpose = context.purpose ?? "agent";
      const { preferredProfileId, lockedProfileId } =
        context.profileProvider === undefined ||
        normalizeCatalogProvider(context.profileProvider) ===
          normalizeCatalogProvider(entry.provider)
          ? context
          : {};
      const modelKey = resolveModelCatalogIdentityKey(entry);
      const runtimeId = context.runtimeOverride?.id;
      const key = JSON.stringify([
        modelKey,
        purpose,
        preferredProfileId ?? null,
        lockedProfileId ?? null,
        runtimeId ?? null,
      ]);
      const cached = evaluations.get(key);
      if (cached) {
        return cached;
      }
      const ownedEntry = resolveOwnedEntry(entry);
      const { nativeRuntime: _nativeRuntime, ...directEntry } = ownedEntry;
      const variants = routeGroups.get(modelKey) ?? [ownedEntry];
      const evaluation: Promise<ModelAuthAvailabilityEvaluation> =
        purpose === "image"
          ? Promise.resolve(
              Object.freeze({
                availability: directAuthResolver.resolveProviderAuthAvailability(
                  ownedEntry.provider,
                  {
                    modelId: ownedEntry.id,
                    preferredProfileId,
                    lockedProfileId,
                    observedRoutes: variants.map(({ api, baseUrl }) => ({ api, baseUrl })),
                  },
                ),
                routeResolution: null,
              }),
            )
          : Promise.resolve().then(() =>
              evaluateModelCatalogEntry(
                {
                  cfg,
                  agentId,
                  authResolver: purpose === "agent" ? authResolver : directAuthResolver,
                  metadataSnapshot,
                  providerOutcomes,
                  preferredProfileId,
                  lockedProfileId,
                  runtimeId,
                },
                purpose === "agent" ? ownedEntry : directEntry,
                variants,
              ),
            );
      const result =
        catalogComplete &&
        liveCatalogProviders.has(normalizeProviderId(ownedEntry.provider)) &&
        !publishedOrConfiguredKeys.has(modelKey)
          ? evaluation.then((result) =>
              result.availability === true && !result.runtimeAuth
                ? { ...result, availability: undefined }
                : result,
            )
          : evaluation;
      evaluations.set(key, result);
      return result;
    },
    async runtime(
      entry: ModelCatalogEntry,
      context: ModelCatalogDecisionContext = {},
    ): Promise<GatewayAgentRuntime | undefined> {
      if (context.purpose !== undefined && context.purpose !== "agent") {
        return undefined;
      }
      if (context.runtimeOverride) {
        return freezeCapturedFacts(structuredClone(context.runtimeOverride));
      }
      const ownedEntry = resolveOwnedEntry(entry);
      const evaluation = await source.evaluate(ownedEntry, context);
      const route = evaluation.selectedRoute;
      const unmanaged = evaluation.routeResolution === null;
      const policy = resolveConfiguredAgentHarnessPolicy({
        config: cfg,
        agentId,
        provider: ownedEntry.provider,
        modelId: ownedEntry.id,
        modelApi: route?.api ?? (unmanaged ? ownedEntry.api : undefined),
        modelBaseUrl: route?.baseUrl ?? (unmanaged ? ownedEntry.baseUrl : undefined),
        requestTransportOverrides: route?.requestTransportOverrides,
        env,
      });
      const nativeRuntime =
        evaluation.availability === true && evaluation.runtimeAuth?.source === "native"
          ? evaluation.runtimeAuth.id
          : undefined;
      if (
        nativeRuntime &&
        policy.runtimeSource !== "model" &&
        policy.runtimeSource !== "provider"
      ) {
        return Object.freeze({ id: nativeRuntime, source: "auth" });
      }
      return policy.runtime === "auto"
        ? undefined
        : Object.freeze({ id: policy.runtime, source: policy.runtimeSource ?? "implicit" });
    },
    async runtimeChoices(
      entry: ModelCatalogEntry,
      context: ModelCatalogDecisionContext = {},
    ): Promise<readonly string[]> {
      if (context.purpose !== undefined && context.purpose !== "agent") {
        return [];
      }
      const ownedEntry = resolveOwnedEntry(entry);
      const provider = normalizeProviderId(ownedEntry.provider);
      const effective = await source.runtime(ownedEntry, context);
      const evaluation = await source.evaluate(ownedEntry, context);
      const routes =
        evaluation.routeResolution?.kind === "routes" ? evaluation.routeResolution.routes : [];
      const policy = resolveConfiguredAgentHarnessPolicy({
        config: cfg,
        agentId,
        provider,
        modelId: ownedEntry.id,
        modelApi: evaluation.selectedRoute?.api ?? ownedEntry.api,
        modelBaseUrl: evaluation.selectedRoute?.baseUrl ?? ownedEntry.baseUrl,
        requestTransportOverrides: evaluation.selectedRoute?.requestTransportOverrides,
        env,
      });
      const candidates = [
        effective?.id,
        OPENCLAW_AGENT_RUNTIME_ID,
        providerAuth[provider]?.runtime,
        ...source.variants(ownedEntry).map((variant) => variant.nativeRuntime),
        ...runtimeBindings
          .filter((binding) => binding.provider === provider)
          .map((binding) => binding.runtime),
        ...routes.flatMap((route) => route.runtimePolicy?.compatibleIds ?? []),
      ];
      const choices: string[] = [];
      const runtimeIds = new Set(
        candidates.map(normalizeOptionalAgentRuntimeId).filter((runtime) => runtime !== undefined),
      );
      for (const runtimeId of runtimeIds) {
        if (runtimeId === "auto" || (policy.forcedByEnvironment && runtimeId !== policy.runtime)) {
          continue;
        }
        const candidate = await source.evaluate(ownedEntry, {
          ...context,
          runtimeOverride: { id: runtimeId, source: "model" },
        });
        if (candidate.availability !== true) {
          continue;
        }
        const compatibleIds = candidate.selectedRoute?.runtimePolicy?.compatibleIds;
        if (compatibleIds && !compatibleIds.includes(runtimeId)) {
          continue;
        }
        if (candidate.runtimeAuth?.source === "native" && candidate.runtimeAuth.id !== runtimeId) {
          continue;
        }
        if (
          runtimeId !== OPENCLAW_AGENT_RUNTIME_ID &&
          runtimeId !== effective?.id &&
          candidate.runtimeAuth?.id !== runtimeId &&
          !compatibleIds?.includes(runtimeId)
        ) {
          continue;
        }
        choices.push(runtimeId);
      }
      return Object.freeze(choices);
    },
    isCurrent: () =>
      getPreparedModelRuntimePublicationRevision() === revision && Date.now() < validUntil,
  });
  return source;
}

export function getPreparedModelCatalogDecisions(
  params: ModelCatalogDecisionFacts,
): PreparedModelCatalogDecisions {
  const revision = getPreparedModelRuntimePublicationRevision();
  if (revision !== cachedPublicationRevision) {
    sourcesByStore = new WeakMap();
    cachedPublicationRevision = revision;
  }
  const catalogComplete = params.catalogComplete ?? isPreparedModelCatalogFull(params.snapshot);
  const identity = [
    params.cfg,
    params.agentId,
    params.workspaceDir,
    params.metadataSnapshot,
    params.snapshot.entries,
    params.snapshot.routeVariants,
    params.snapshot.staticEntries,
    params.snapshot.providerOutcomes,
    params.snapshot.runtimeBindings,
    params.auth.providerAuth,
    params.authMaterializations?.length ? params.authMaterializations : undefined,
    catalogComplete,
    params.env ?? process.env,
  ];
  const cached = sourcesByStore.get(params.auth.authStore) ?? [];
  const existing = cached.find((entry) =>
    entry.identity.every((value, index) => value === identity[index]),
  );
  if (existing?.source.isCurrent()) {
    return existing.source;
  }
  const source = createDecisionSource(params, revision, catalogComplete);
  if (existing) {
    existing.source = source;
  } else {
    cached.push({ identity, source });
  }
  sourcesByStore.set(params.auth.authStore, cached);
  return source;
}
