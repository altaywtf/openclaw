/**
 * Builds auth forwarding decisions for prepared runtime plans. Provider aliases
 * and harness auth owners are resolved before session auth profiles can be
 * safely forwarded.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import {
  type ProviderAuthAliasLookupParams,
  resolveProviderIdForAuth,
} from "../provider-auth-aliases.js";
import type { AgentRuntimeAuthPlan } from "./types.js";

const CODEX_HARNESS_AUTH_PROVIDER = "openai";
// Empty metadata disables plugin alias lookups without changing the downstream
// resolver contract, matching the "plugins disabled" runtime-plan state.
const EMPTY_PROVIDER_AUTH_ALIAS_METADATA = {
  plugins: [],
} satisfies NonNullable<ProviderAuthAliasLookupParams["metadataSnapshot"]>;

/** Use the prepared owner decision; a selected auth mode alone cannot override harness auth. */
export function agentRuntimeAuthPlanRequiresHostApiKey(plan?: AgentRuntimeAuthPlan): boolean {
  if (plan?.modelRoute) {
    return plan.modelRoute.authRequirement === "api-key";
  }
  return plan?.requiresHostApiKey === true;
}

function resolveHarnessAuthProvider(params: {
  harnessId?: string;
  harnessRuntime?: string;
}): string | undefined {
  const harnessId = normalizeOptionalAgentRuntimeId(params.harnessId);
  const runtime = normalizeOptionalAgentRuntimeId(params.harnessRuntime);
  return harnessId === "codex" || runtime === "codex" ? CODEX_HARNESS_AUTH_PROVIDER : undefined;
}

/** Builds the auth forwarding plan for one resolved agent runtime. */
export function buildAgentRuntimeAuthPlan(params: {
  provider: string;
  modelId?: string;
  authProfileProvider?: string;
  authProfileMode?: string;
  sessionAuthProfileId?: string;
  sessionAuthProfileSource?: "auto" | "user" | "user-link";
  sessionAuthProfileCandidateIds?: string[];
  modelRoute?: AgentRuntimeAuthPlan["modelRoute"];
  deferredRouteSupport?: AgentRuntimeAuthPlan["deferredRouteSupport"];
  credentialSource?: AgentRuntimeAuthPlan["credentialSource"];
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
  providerAuthAliasesEnabled?: boolean;
  harnessId?: string;
  harnessRuntime?: string;
  allowHarnessAuthProfileForwarding?: boolean;
}): AgentRuntimeAuthPlan {
  const providerAuthAliasesEnabled =
    params.providerAuthAliasesEnabled ?? params.config?.plugins?.enabled !== false;
  const metadataSnapshot =
    params.metadataSnapshot ??
    (providerAuthAliasesEnabled ? undefined : EMPTY_PROVIDER_AUTH_ALIAS_METADATA);
  const aliasLookupParams = {
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    ...(metadataSnapshot ? { metadataSnapshot } : {}),
  };
  const providerForAuth = resolveProviderIdForAuth(params.provider, aliasLookupParams);
  const authProfileProviderForAuth = resolveProviderIdForAuth(
    params.authProfileProvider ?? params.provider,
    aliasLookupParams,
  );
  const defaultHarnessAuthProvider = resolveHarnessAuthProvider(params);
  const customCodexProvider =
    defaultHarnessAuthProvider === CODEX_HARNESS_AUTH_PROVIDER &&
    providerForAuth !== "codex" &&
    providerForAuth !== CODEX_HARNESS_AUTH_PROVIDER;
  // A custom workload key belongs to its provider, not a native OpenAI account.
  // Omit the native owner even before credentials are selected so callers cannot
  // bootstrap an unrelated OpenAI profile for this route.
  const harnessAuthProvider = customCodexProvider ? undefined : defaultHarnessAuthProvider;
  const harnessProviderForAuth = harnessAuthProvider
    ? resolveProviderIdForAuth(harnessAuthProvider, aliasLookupParams)
    : undefined;
  const harnessCanForwardProfile =
    params.allowHarnessAuthProfileForwarding !== false &&
    harnessProviderForAuth &&
    harnessProviderForAuth === authProfileProviderForAuth;
  const providerCanForwardProfile =
    !harnessProviderForAuth &&
    providerForAuth === authProfileProviderForAuth &&
    (!customCodexProvider ||
      (params.allowHarnessAuthProfileForwarding !== false &&
        (params.authProfileMode === "api-key" || params.authProfileMode === "api_key")));
  const canForwardProfile = providerCanForwardProfile || harnessCanForwardProfile;
  const forwardedAuthProfileId = canForwardProfile ? params.sessionAuthProfileId : undefined;

  // Forward only when the selected provider/harness resolves to the same auth
  // owner as the stored session profile; otherwise the runtime must choose auth.
  return {
    providerForAuth,
    ...(params.modelId ? { modelId: params.modelId } : {}),
    authProfileProviderForAuth,
    ...(harnessProviderForAuth ? { harnessAuthProvider: harnessProviderForAuth } : {}),
    ...(customCodexProvider && providerCanForwardProfile ? { requiresHostApiKey: true } : {}),
    ...(canForwardProfile ? { forwardedAuthProfileId } : {}),
    ...(canForwardProfile && params.sessionAuthProfileId && params.sessionAuthProfileSource
      ? {
          // Person-linked pins forward at user-pin strength; the wire plan
          // keeps the closed auto/user contract.
          forwardedAuthProfileSource: params.sessionAuthProfileSource === "auto" ? "auto" : "user",
        }
      : {}),
    ...(canForwardProfile && params.sessionAuthProfileCandidateIds?.length
      ? { forwardedAuthProfileCandidateIds: params.sessionAuthProfileCandidateIds }
      : {}),
    ...(canForwardProfile && params.authProfileMode
      ? { selectedAuthMode: params.authProfileMode }
      : {}),
    ...(params.modelRoute ? { modelRoute: params.modelRoute } : {}),
    ...(params.deferredRouteSupport ? { deferredRouteSupport: params.deferredRouteSupport } : {}),
    ...(params.credentialSource ? { credentialSource: params.credentialSource } : {}),
  } satisfies AgentRuntimeAuthPlan;
}
