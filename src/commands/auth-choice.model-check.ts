import { resolveAgentDir, resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import { cloneAuthProfileStore } from "../agents/auth-profiles/clone.js";
import { mergeAuthProfileStores } from "../agents/auth-profiles/persisted.js";
import { findModelInCatalog } from "../agents/model-catalog-lookup.js";
import { prepareModelCatalogView } from "../agents/model-catalog-view.js";
import { resolvePublishedModelCatalogOwner } from "../agents/prepared-model-catalog-owner.js";
import { getPreparedModelRuntimeAuthMaterializations } from "../agents/prepared-model-runtime-auth.js";
import { acquireReadOnlyPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import { buildProviderAuthRecoveryHint } from "../agents/provider-auth-recovery-hint.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthResult } from "../plugins/types.js";
import type { WizardPrompter } from "../wizard/prompts.js";

type DefaultModelAuthOptions = {
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pendingAuthProfiles?: ProviderAuthResult["profiles"];
};

export async function resolveDefaultModelAuthStatus(
  config: OpenClawConfig,
  { pendingAuthProfiles = [], ...ownerParams }: DefaultModelAuthOptions = {},
) {
  const agentDir =
    ownerParams.agentDir ??
    (ownerParams.agentId
      ? resolveAgentDir(config, ownerParams.agentId, ownerParams.env)
      : resolveDefaultAgentDir(config, ownerParams.env));
  const lease = await acquireReadOnlyPreparedModelRuntime({
    config,
    ...ownerParams,
    agentDir,
  });
  try {
    const owner = resolvePublishedModelCatalogOwner(lease.snapshot);
    const authStore = mergeAuthProfileStores(
      cloneAuthProfileStore(owner.authStore),
      {
        version: owner.authStore.version,
        profiles: Object.fromEntries(
          pendingAuthProfiles.map(({ profileId, credential }) => [profileId, credential]),
        ),
      },
      { preserveBaseRuntimeExternalProfiles: true },
    );
    const view = await prepareModelCatalogView({
      cfg: config,
      agentId: owner.agentId,
      workspaceDir: owner.workspaceDir,
      snapshot: owner.modelCatalog,
      metadataSnapshot: owner.metadataSnapshot,
      auth: { authStore, providerAuth: owner.providerAuth },
      authMaterializations: getPreparedModelRuntimeAuthMaterializations(owner),
      env: ownerParams.env,
      view: "configured",
    });
    const { provider, model } = view.resolvedDefault;
    const entry = findModelInCatalog(view.entries, provider, model);
    return { provider, model, evaluation: entry ? view.evaluate(entry) : undefined };
  } finally {
    lease.release();
  }
}

export async function warnIfModelConfigLooksOff(
  config: OpenClawConfig,
  prompter: WizardPrompter,
  options?: DefaultModelAuthOptions,
) {
  const { provider, model, evaluation } = await resolveDefaultModelAuthStatus(config, options);
  if (evaluation?.availability === true) {
    return;
  }
  const route = evaluation?.routeResolution;
  let warning: string;
  if (route?.kind === "incompatible") {
    warning = `Model route is incompatible for "${provider}/${model}": ${route.message}`;
  } else if (evaluation?.unavailableReason === "missing-auth") {
    warning = `No auth configured for provider "${provider}". The agent may fail until credentials are added. ${buildProviderAuthRecoveryHint(
      {
        provider,
        config,
        includeEnvVar: evaluation.selectedRoute?.authRequirement !== "subscription",
      },
    )}`;
  } else if (evaluation?.availability === false) {
    warning = `Auth is unavailable for "${provider}/${model}". ${buildProviderAuthRecoveryHint({
      provider,
      config,
      includeEnvVar: evaluation.selectedRoute?.authRequirement !== "subscription",
    })}`;
  } else {
    warning = `Auth readiness could not be confirmed for "${provider}/${model}". Verify the selected model route and credential source before continuing.`;
  }
  await prompter.note(warning, "Model check");
}
