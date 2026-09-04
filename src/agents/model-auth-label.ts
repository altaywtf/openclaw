import { resolveSelectedAndActiveModel } from "../auto-reply/model-runtime.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLazyPromise } from "../shared/lazy-promise.js";
import type { GatewayAgentRuntime } from "../shared/session-types.js";
import { resolveAgentDir, resolveAgentWorkspaceDir, resolveSessionAgentId } from "./agent-scope.js";
import { resolveConfiguredAgentHarnessPolicy } from "./harness/policy.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import { findModelInCatalog } from "./model-catalog-lookup.js";
import { getPreparedModelRuntimeAuthMaterializations } from "./prepared-model-runtime-auth.js";
import { resolveSessionRuntimeOverrideForProvider } from "./session-runtime-compat.js";

export type StatusModelAuth =
  | {
      kind: "prepared";
      evaluation: ModelAuthAvailabilityEvaluation;
      displayOverride?: { label: string | undefined };
    }
  | { kind: "provided"; label: string | undefined }
  | { kind: "unknown" };

type StatusModelRef = ReturnType<typeof resolveSelectedAndActiveModel>["selected"];
type PreparedStatusModelFact = StatusModelRef & {
  auth: StatusModelAuth;
  runtime?: GatewayAgentRuntime;
};

export type PreparedStatusModelFacts = {
  selected: PreparedStatusModelFact;
  active: PreparedStatusModelFact;
  activeDiffers: boolean;
  lockedProfileId?: string;
};

export function resolveModelAuthLabel(auth?: StatusModelAuth): string | undefined {
  if (!auth || auth.kind === "unknown") {
    return undefined;
  }
  if (auth.kind === "provided" || auth.displayOverride) {
    const label = auth.kind === "provided" ? auth.label : auth.displayOverride?.label;
    return label === "unknown" ? undefined : label;
  }
  const evaluation = auth.evaluation;
  if (evaluation.availability === false) {
    return evaluation.unavailableReason
      ? `unavailable (${evaluation.unavailableReason})`
      : "unavailable";
  }
  if (evaluation.availability !== true) {
    return undefined;
  }
  const mode = evaluation.selectedAuthMode === "api_key" ? "api-key" : evaluation.selectedAuthMode;
  if (mode) {
    return evaluation.selectedProfileId ? `${mode} (${evaluation.selectedProfileId})` : mode;
  }
  return evaluation.runtimeAuth?.source === "native"
    ? `native (${evaluation.runtimeAuth.id})`
    : undefined;
}

export async function prepareStatusModelAuth(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  sessionEntry?: SessionEntry;
  provider: string;
  model: string;
  workspaceDir?: string;
  resolvedHarness?: string;
  modelAuthOverride?: string;
  activeModelAuthOverride?: string;
}): Promise<PreparedStatusModelFacts> {
  const sessionEntry = params.sessionEntry ? { ...params.sessionEntry } : undefined;
  const agentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
    agentId: params.agentId,
  });
  const agentDir = resolveAgentDir(params.cfg, agentId);
  const workspaceDir =
    params.workspaceDir ??
    sessionEntry?.spawnedWorkspaceDir ??
    resolveAgentWorkspaceDir(params.cfg, agentId);
  const refs = resolveSelectedAndActiveModel({
    selectedProvider: sessionEntry?.providerOverride?.trim() ?? params.provider,
    selectedModel: sessionEntry?.modelOverride?.trim() ?? params.model,
    parseSelectedProvider: Boolean(
      sessionEntry?.modelOverride?.trim() && !sessionEntry?.providerOverride?.trim(),
    ),
    sessionEntry,
  });
  const runtimeForProvider = (provider: string) =>
    resolveSessionRuntimeOverrideForProvider({ provider, entry: sessionEntry, cfg: params.cfg });
  const selectedRuntime = params.resolvedHarness ?? runtimeForProvider(refs.selected.provider);
  const activeRuntime = sessionEntry?.model
    ? (sessionEntry.agentHarnessId ?? runtimeForProvider(refs.active.provider))
    : selectedRuntime;
  const profileId = sessionEntry?.authProfileOverride;
  const profileSelection =
    sessionEntry?.authProfileOverrideSource === "auto"
      ? { preferredProfileId: profileId }
      : { lockedProfileId: profileId };
  const selectedProvided = Object.hasOwn(params, "modelAuthOverride");
  const selectedLabel = params.modelAuthOverride;
  const activeProvided = Object.hasOwn(params, "activeModelAuthOverride");
  const activeLabel = params.activeModelAuthOverride;
  const loadCatalogFacts = createLazyPromise(
    async () => {
      const { loadResolvedPublishedModelCatalogOwner } =
        await import("./prepared-model-catalog.js");
      const owner = await loadResolvedPublishedModelCatalogOwner({
        config: params.cfg,
        agentId,
        agentDir,
        workspaceDir,
        readOnly: true,
      });
      return {
        cfg: owner.config,
        agentId: owner.agentId,
        workspaceDir: owner.workspaceDir,
        snapshot: owner.modelCatalog,
        metadataSnapshot: owner.metadataSnapshot,
        auth: { authStore: owner.authStore, providerAuth: owner.providerAuth },
        authMaterializations: getPreparedModelRuntimeAuthMaterializations(owner),
      };
    },
    { cacheRejections: true },
  );
  type CatalogView = Awaited<
    ReturnType<typeof import("./model-catalog-view.js").prepareModelCatalogView>
  >;
  const views = new Map<string | undefined, Promise<CatalogView>>();
  const prepare = async (
    ref: StatusModelRef,
    runtimeId: string | undefined,
    provided: boolean,
    label: string | undefined,
  ): Promise<PreparedStatusModelFact> => {
    const runtimeOverride: GatewayAgentRuntime | undefined = runtimeId
      ? { id: runtimeId, source: "session" }
      : undefined;
    if (provided && !profileId) {
      const policy = resolveConfiguredAgentHarnessPolicy({
        config: params.cfg,
        agentId,
        provider: ref.provider,
        modelId: ref.model,
      });
      return {
        ...ref,
        auth: { kind: "provided", label },
        runtime:
          runtimeOverride ??
          (policy.runtime === "auto"
            ? undefined
            : { id: policy.runtime, source: policy.runtimeSource ?? "implicit" }),
      };
    }
    let pending = views.get(runtimeId);
    if (!pending) {
      pending = import("./model-catalog-view.js").then(async ({ prepareModelCatalogView }) =>
        prepareModelCatalogView({
          ...(await loadCatalogFacts()),
          view: "all",
          ...profileSelection,
          runtimeOverride,
        }),
      );
      views.set(runtimeId, pending);
    }
    const view = await pending;
    const entry = findModelInCatalog(view.entries, ref.provider, ref.model);
    return entry
      ? {
          ...ref,
          auth: {
            kind: "prepared",
            evaluation: view.evaluate(entry),
            ...(provided ? { displayOverride: { label } } : {}),
          },
          runtime: view.runtime(entry),
        }
      : {
          ...ref,
          auth: provided ? { kind: "provided", label } : { kind: "unknown" },
          runtime: runtimeOverride,
        };
  };
  const selected = await prepare(refs.selected, selectedRuntime, selectedProvided, selectedLabel);
  const active =
    !refs.activeDiffers && activeRuntime === selectedRuntime && !activeProvided
      ? selected
      : await prepare(refs.active, activeRuntime, activeProvided, activeLabel);
  return {
    selected,
    active,
    activeDiffers: refs.activeDiffers,
    lockedProfileId: profileSelection.lockedProfileId,
  };
}
