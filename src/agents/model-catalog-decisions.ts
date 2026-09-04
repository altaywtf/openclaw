import { cloneConfigWithResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  PREPARED_THINKING_POLICY,
  type ThinkingCatalogPolicyCarrier,
} from "../plugins/provider-thinking-catalog.js";
import type { GatewayAgentRuntime } from "../shared/session-types.js";
import { cloneAuthProfileStore } from "./auth-profiles/clone.js";
import type { RuntimeAuthMaterialization } from "./auth-profiles/runtime-materializations.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { resolveConfiguredAgentHarnessPolicy } from "./harness/policy.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import {
  createModelCatalogAuthResolver,
  createModelCatalogEntryEvaluator,
} from "./model-catalog-auth.js";
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
  preferredProfileId?: string;
  lockedProfileId?: string;
  runtimeOverride?: GatewayAgentRuntime;
};

export type PreparedModelCatalogDecisions = {
  readonly entries: readonly ModelCatalogEntry[];
  variants(entry: Pick<ModelCatalogEntry, "provider" | "id">): readonly ModelCatalogEntry[];
  evaluate(
    entry: ModelCatalogEntry,
    context?: ModelCatalogDecisionContext,
  ): Promise<ModelAuthAvailabilityEvaluation>;
  runtime(
    entry: ModelCatalogEntry,
    context?: ModelCatalogDecisionContext,
  ): Promise<GatewayAgentRuntime | undefined>;
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
  const authMaterializations = freezeCapturedFacts(
    structuredClone(params.authMaterializations ?? []),
  );
  const providerOutcomes = freezeCapturedFacts(structuredClone(params.snapshot.providerOutcomes));
  const env = Object.freeze({ ...(params.env ?? process.env) });
  const canonicalRows = new Map<string, ModelCatalogEntry>();
  const routeGroups = new Map<string, readonly ModelCatalogEntry[]>();
  const configuredRows = buildConfiguredModelCatalog({
    cfg,
    workspaceDir,
    manifestPlugins: metadataSnapshot,
  });
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
  const contexts = new Map<string, ReturnType<typeof createModelCatalogEntryEvaluator>>();
  const resolveOwnedEntry = (entry: ModelCatalogEntry): ModelCatalogEntry =>
    canonicalRows.get(resolveModelCatalogIdentityKey(entry)) ?? {
      provider: entry.provider,
      id: entry.id,
      name: entry.id,
    };
  const source: PreparedModelCatalogDecisions = Object.freeze({
    entries: Object.freeze([...canonicalRows.values()]),
    variants: (entry: Pick<ModelCatalogEntry, "provider" | "id">) =>
      routeGroups.get(resolveModelCatalogIdentityKey(entry)) ?? EMPTY_CATALOG_ROWS,
    evaluate(entry: ModelCatalogEntry, context: ModelCatalogDecisionContext = {}) {
      const purpose = context.purpose ?? "agent";
      const { preferredProfileId, lockedProfileId } = context;
      const contextKey = JSON.stringify([
        purpose,
        preferredProfileId ?? null,
        lockedProfileId ?? null,
        context.runtimeOverride?.id ?? null,
      ]);
      let evaluateEntry = contexts.get(contextKey);
      if (!evaluateEntry) {
        if (purpose === "image") {
          const pending = new Map<string, Promise<ModelAuthAvailabilityEvaluation>>();
          evaluateEntry = (imageEntry, variants = []) => {
            const key = resolveModelCatalogIdentityKey(imageEntry);
            let evaluation = pending.get(key);
            if (!evaluation) {
              evaluation = Promise.resolve(
                Object.freeze({
                  availability: directAuthResolver.resolveProviderAuthAvailability(
                    imageEntry.provider,
                    {
                      modelId: imageEntry.id,
                      preferredProfileId,
                      lockedProfileId,
                      observedRoutes: variants.map((variant) => ({
                        api: variant.api,
                        baseUrl: variant.baseUrl,
                      })),
                    },
                  ),
                  routeResolution: null,
                }),
              );
              pending.set(key, evaluation);
            }
            return evaluation;
          };
        } else {
          evaluateEntry = createModelCatalogEntryEvaluator({
            cfg,
            agentId,
            authResolver: purpose === "agent" ? authResolver : directAuthResolver,
            metadataSnapshot,
            providerOutcomes,
            preferredProfileId,
            lockedProfileId,
            runtimeId: context.runtimeOverride?.id,
          });
        }
        contexts.set(contextKey, evaluateEntry);
      }
      const ownedEntry = resolveOwnedEntry(entry);
      const { nativeRuntime: _nativeRuntime, ...directEntry } = ownedEntry;
      return evaluateEntry(
        purpose === "agent" ? ownedEntry : directEntry,
        routeGroups.get(resolveModelCatalogIdentityKey(ownedEntry)) ?? [ownedEntry],
      );
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
