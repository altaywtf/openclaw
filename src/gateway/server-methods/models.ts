import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
// Models gateway methods project published catalog facts.
import {
  ErrorCodes,
  errorShape,
  validateModelsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "../../agents/prepared-model-runtime.errors.js";
import { resolveSessionModelProfiles } from "../../agents/session-model-ref.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import type { ChatMetadataReadParams } from "./chat-metadata-contract.js";
import { projectSessionModelCatalog } from "./chat-metadata-session-projection.js";
import { resolveRequestedChatAgentId } from "./chat-origin-routing.js";
import { buildModelsListResult, UnknownModelCatalogProviderError } from "./models-list-result.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export { buildModelsListResult };

export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateModelsListParams, "models.list", respond)) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    let sessionContext: ChatMetadataReadParams | undefined;
    if (params.sessionKey) {
      const requested = resolveRequestedChatAgentId({
        cfg,
        requestedSessionKey: params.sessionKey,
        agentId: params.agentId,
      });
      if (!requested.ok) {
        respond(false, undefined, requested.error);
        return;
      }
      const session = loadGatewaySessionEntryReadOnly(params.sessionKey, {
        agentId: requested.agentId,
        projection: "list",
      });
      sessionContext = {
        agentId: resolveSessionAgentId({
          sessionKey: session.canonicalKey,
          config: session.cfg,
          agentId: requested.agentId,
        }),
        sessionKey: session.canonicalKey,
        sessionEntry: session.entry,
      };
    }
    const resolved = resolveAgentIdOrRespondError({
      rawAgentId: sessionContext?.agentId ?? params.agentId ?? tryResolveAmbientOwnerAgentId(cfg),
      respond,
      cfg,
      normalize: normalizeOptionalString,
    });
    if (!resolved) {
      return;
    }
    try {
      const result = await buildModelsListResult({
        source: { kind: "gateway", context },
        agentId: resolved.agentId,
        params,
        selection: resolveSessionModelProfiles(cfg, resolved.agentId, sessionContext?.sessionEntry),
      });
      respond(
        true,
        sessionContext
          ? {
              ...result,
              models: projectSessionModelCatalog(
                sessionContext,
                result.models,
                context.getRuntimeConfig(),
              ),
            }
          : result,
        undefined,
      );
    } catch (error) {
      if (error instanceof UnknownModelCatalogProviderError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
      if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
        throw error;
      }
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, error.message));
    }
  },
};
