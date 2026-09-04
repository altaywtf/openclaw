import {
  ErrorCodes,
  errorShape,
  validateModelsAuthRefreshParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentDir, tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { noteRuntimeAuthProfileStorePersistedMutation } from "../../agents/auth-profiles/runtime-snapshots.js";
import {
  clearCurrentProviderAuthState,
  warmCurrentProviderAuthStateOffMainThread,
} from "../../agents/model-provider-auth.js";
import { prepareModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { refreshActiveProviderAuthRuntimeSnapshot } from "../../secrets/runtime.js";
import { formatForLog } from "../ws-log.js";
import { modelAuthAgentScopeError, resolveModelAuthAgentScope } from "./model-auth-agent-scope.js";
import { clearModelAuthStatusUsageCache } from "./models-auth-status-usage-cache.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const log = createSubsystemLogger("models-auth-status");

/**
 * Invalidate auxiliary usage and prepared provider-auth state after an auth
 * mutation. Auth health itself is rebuilt on every request; only outbound
 * usage enrichment is cached.
 */
export function invalidateModelAuthStatusCache(): void {
  clearModelAuthStatusUsageCache();
  // The prepared provider-auth map (model-provider-auth.ts) was built from
  // the pre-mutation auth state, so it must be invalidated alongside this
  // cache whenever an auth-profile mutation lands (logout, login, token
  // rotation, etc.). Without this, `/models` and pickers keep advertising
  // providers the running gateway can no longer authenticate.
  clearCurrentProviderAuthState();
}

/** Refresh transient Gateway auth owners after one durable credential mutation. */
export async function refreshModelAuthStateAfterMutation(
  context: GatewayRequestContext,
  operation: "login" | "logout" | "update",
  agentId: string,
): Promise<void> {
  invalidateModelAuthStatusCache();
  const cfg = context.getRuntimeConfig();
  const agentDir = resolveAgentDir(cfg, agentId);
  await refreshActiveProviderAuthRuntimeSnapshot();
  // A durable store write already raised this mutation; a native sign-in (Codex) changes no store
  // row, so raise it here as well. The auth publication owner coalesces both into one static rebuild
  // that reuses the plugin generation and births discovery only when the profile set changed. A
  // config-wide republish here would rebuild every generation and re-run discovery per login.
  noteRuntimeAuthProfileStorePersistedMutation(agentDir, {
    credentialsChanged: true,
    profileSetChanged: operation !== "update",
    stateChanged: false,
    profileIds: [],
  });
  // Ordinary Models reads never wait on discovery, so the mutated agent's configured owner
  // republishes before the caller sees success. A missing owner is a lifecycle bug, not a reason
  // to activate a standalone runtime here.
  await prepareModelRuntimeSnapshot({ config: cfg, agentId, agentDir });
  void warmCurrentProviderAuthStateOffMainThread(cfg).catch((err: unknown) => {
    log.warn(`provider auth state rewarm after ${operation} failed: ${formatForLog(err)}`);
  });
}

export const modelsAuthRefreshHandlers: GatewayRequestHandlers = {
  "models.authRefresh": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateModelsAuthRefreshParams, "models.authRefresh", respond)
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const scope = resolveModelAuthAgentScope(
      cfg,
      params.agentId === undefined || params.agentId === ""
        ? tryResolveAmbientOwnerAgentId(cfg)
        : params.agentId,
    );
    if (!scope.ok) {
      respond(false, undefined, modelAuthAgentScopeError(scope));
      return;
    }
    try {
      await refreshModelAuthStateAfterMutation(context, params.operation, scope.agentId);
      respond(true, { refreshed: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
